// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 환경변수 확인
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ELEVATOR_KEY = process.env.ELEVATOR_KEY || MOLIT_KEY;

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY) console.warn("⚠️ 환경변수 확인 필요");
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 4. JUSO 검색
async function searchAddress(input) {
  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  const params = { confmKey: JUSO_KEY, currentPage: "1", countPerPage: "5", keyword: input, resultType: "json" };
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!data.results || data.results.common.errorCode !== "0") return null;
    const juso = data.results.juso[0];
    if (!juso) return null;
    return {
        sigunguCd: juso.admCd.substring(0, 5), bjdongCd: juso.admCd.substring(5, 10),
        bun: String(juso.lnbrMnnm || "").padStart(4, "0"), ji: String(juso.lnbrSlno || "").padStart(4, "0"),
        jibun: `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`, roadAddr: juso.roadAddr,
        siNm: juso.siNm, sggNm: juso.sggNm, buldNm: juso.bdNm, rawJuso: juso, 
    };
  } catch (e) { return null; }
}

// 5. 데이터 조회 함수들
async function callMolitApiSingle(sigunguCd, bjdongCd, bun, ji) {
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`);
  const params = { serviceKey: MOLIT_KEY, sigunguCd, bjdongCd, platGbCd: "0", bun, ji, _type: "json", numOfRows: "100", pageNo: "1" };
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  try {
    const res = await fetch(url.toString());
    const text = await res.text();
    if (!res.ok) return [];
    const data = JSON.parse(text);
    if (data.response?.header?.resultCode !== "00") return [];
    const rawItems = data.response?.body?.items?.item;
    if (!rawItems) return [];
    return Array.isArray(rawItems) ? rawItems : [rawItems];
  } catch (e) { return []; }
}

async function fetchBuildingRegister(addressInfo) {
  const { sigunguCd, bjdongCd, bun, ji } = addressInfo;
  const baseJi = Number(ji); const jiOffsets = [0, -1, 1, -2, 2]; 
  for (const offset of jiOffsets) {
    const targetJi = String(baseJi + offset).padStart(4, '0');
    const items = await callMolitApiSingle(sigunguCd, bjdongCd, bun, targetJi);
    if (items.length > 0) return items;
  }
  return [];
}

function generateElevatorSearchNames(addressInfo) {
    const rawBuldNm = addressInfo.buldNm;
    if (!rawBuldNm || rawBuldNm.length < 2) return [];
    const cleaned = rawBuldNm.replace(/\s/g, '');
    let names = new Set([cleaned]);
    const matchDanji = cleaned.match(/(\d+단지)$/);
    if (matchDanji) names.add(matchDanji[1]);
    const firstWord = rawBuldNm.split(/\s+/)[0];
    if (firstWord && firstWord !== cleaned) names.add(firstWord);
    const filterOut = [addressInfo.siNm, addressInfo.sggNm, addressInfo.siNm.replace(/도|시/g, ''), addressInfo.sggNm.replace(/시|군|구/g, '')];
    return Array.from(names).filter(n => n.length > 1 && !filterOut.includes(n));
}

async function fetchElevatorInfo(siNm, sggNm, buldNm) {
    if (!buldNm) return { count: 0, items: [] };
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM`);
    const params = { serviceKey: ELEVATOR_KEY, pageNo: "1", numOfRows: "100", _type: "json", sido: siNm, sigungu: sggNm, buld_nm: buldNm };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    try {
        const res = await fetch(url.toString());
        const text = await res.text();
        if (!res.ok) return { count: 0, items: [] };
        const data = JSON.parse(text);
        if (data.response?.header?.resultCode !== "00") return { count: 0, items: [] };
        const count = Number(data.response?.body?.totalCount) || 0;
        const rawItems = data.response?.body?.items?.item;
        if (count === 0 || !rawItems) return { count: 0, items: [] };
        const items = Array.isArray(rawItems) ? rawItems : [rawItems];
        return { count, items };
    } catch (e) { return { count: 0, items: [] }; }
}

async function searchElevatorWithFallbackNames(addressInfo) {
    const searchNames = generateElevatorSearchNames(addressInfo);
    for (const name of searchNames) {
        const result = await fetchElevatorInfo(addressInfo.siNm, addressInfo.sggNm, name);
        if (result.count > 0) return result;
    }
    return { count: 0, items: [] };
}

function calculateSimilarity(str1, str2) {
    const s1 = (str1||'').replace(/\s/g,'').toUpperCase(); const s2 = (str2||'').replace(/\s/g,'').toUpperCase();
    if (!s1 || !s2) return 0;
    let matches = 0; const len = Math.min(s1.length, s2.length);
    for(let i=0; i<len; i++) if(s1[i]===s2[i]) matches++;
    return matches / Math.max(s1.length, s2.length);
}

function findBestMatchingElevator(targetName, elevatorItems) {
    let best = null, max = -1;
    const unique = Array.from(new Map(elevatorItems.map(i => [i.elevatorNo, i])).values());
    for (const item of unique) {
        const score = calculateSimilarity(targetName, item.buldNm);
        if (score > max) { max = score; best = item; }
    }
    return best;
}

function getElevatorSummary(elevatorItems) {
    if (!elevatorItems?.length) return { maxFloor: 0 };
    const maxFloor = Math.max(...elevatorItems.map(i => Number(i.divGroundFloorCnt) || 0));
    return { maxFloor };
}

function buildMolitSummary(items) {
    const filtered = items.filter(it => {
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;
        if ((totArea === 0 || grndFlrCnt === 0) && grndFlrCnt < 16) return false;
        const pCode = it.mainPurpsCd?.trim() || '';
        if (pCode === '17000' || pCode === '21000') return false;
        return true;
    });
    
    const maxFloor = filtered.length ? Math.max(...filtered.map(it => Number(it.grndFlrCnt) || 0)) : 0;
    const daJungList = filtered.filter(it => ["공동주택", "제2종근린생활시설", "문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));
    const gaMokArea = daJungList.filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm)).reduce((sum, it) => sum + Number(it.totArea), 0);
    const gaMokType = daJungList.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));

    return { totalCount: filtered.length, maxFloor, gaMokArea, gaMokType: gaMokType?.mainPurpsCdNm || null, items: daJungList };
}

// 7. 안전 등급 결정 (색상 변경: 다중=Green, 일반=Blue)
function determineSafetyGrade(molitSummary, elevatorSummary, isFallback) {
    const finalMaxFloor = Math.max(molitSummary?.maxFloor || 0, elevatorSummary?.maxFloor || 0);
    const gaMokArea = molitSummary?.gaMokArea || 0;
    const hasElevatorData = elevatorSummary.maxFloor > 0;
    const assumedElevator = (molitSummary.totalCount > 0 && finalMaxFloor >= 2);
    
    const isGaMok = gaMokArea >= 5000;
    const isNaMok = finalMaxFloor >= 16;
    
    // [다중이용건축물] -> Green (요청 반영)
    if (isGaMok || isNaMok) {
        return {
            code: 'GREEN',
            badge: '교육 대상',
            colorTheme: 'green', // 🚨 다중이용 = 초록색
            title: '비상구출운전 승강기관리교육(12시간)',
            reason_type: isGaMok ? '다중이용건축물(가목)' : '16층 이상(나목)',
            desc_prefix: isGaMok ? `가목 용도 면적(${gaMokArea.toFixed(2)}㎡) 기준을 초과하여 다중이용건축물입니다.` : `16층 이상(${finalMaxFloor}층) 건축물이므로 다중이용건축물입니다.`
        };
    }

    // [일반건축물] -> Blue (요청 반영)
    if (hasElevatorData || assumedElevator) {
         return {
            code: 'BLUE',
            badge: '교육 대상',
            colorTheme: 'blue', // 🚨 일반 = 파란색
            title: '승강기 관리교육(4시간)',
            reason_type: '일반건축물(승강기 보유)',
            desc_prefix: hasElevatorData 
                ? '승강기 정보가 확인된 일반건축물입니다.' 
                : `전산상 승강기 정보는 없으나, ${finalMaxFloor}층 건물이므로 승강기 보유로 간주됩니다.`
        };
    }

    // [확인 필요]
    if (finalMaxFloor >= 2) {
        return {
            code: 'YELLOW',
            badge: '확인 필요',
            colorTheme: 'yellow',
            title: '⚠️ 승강기 설치 여부 확인 필요',
            reason_type: '데이터 불일치',
            desc_prefix: '2층 이상 건물이지만 승강기 정보가 조회되지 않았습니다. 현장 확인이 필요합니다.'
        };
    }

    // [대상 아님]
    return {
        code: 'GRAY',
        badge: '대상 아님',
        colorTheme: 'gray',
        title: '교육 의무 없음',
        reason_type: '대상 아님',
        desc_prefix: '1층 이하의 건물이거나 승강기가 없어 교육 대상이 아닙니다.'
    };
}

// 8. LLM 판단 및 설명 생성
async function llmJudgment(molitSummary, elevatorSummary) {
    // AI에게 판단을 맡기기 위해 가공되지 않은 Raw Data를 줍니다.
    const dataContext = {
        "건축물대장_최고층": molitSummary.maxFloor,
        "건축물대장_가목면적": molitSummary.gaMokArea,
        "건축물대장_가목용도": molitSummary.gaMokType,
        "승강기_최고층": elevatorSummary.maxFloor,
        "데이터_출처_상태": (molitSummary.totalCount === 0) ? "건축물대장 없음(승강기만 존재)" : "정상"
    };

    const prompt = `
    [역할] 너는 건축법 전문가 AI야.
    [데이터] ${JSON.stringify(dataContext)}
    [판단 기준] 다중이용건축물 여부(예/아니오)를 판단해.
    1. 가목: '건축물대장_가목용도'가 존재하고 '건축물대장_가목면적'이 5000㎡ 이상이면 '예'.
    2. 나목: '건축물대장_최고층'과 '승강기_최고층' 중 더 높은 층수가 16층 이상이면 '예'.
    3. 위 두 가지 중 하나라도 해당하면 '예', 아니면 '아니오'.
    
    [출력 형식]
    반드시 JSON 포맷으로만 응답해.
    {"decision": "예/아니오", "reason": "판단 근거를 한 문장으로 요약"}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0, // 정답을 요구하므로 창의성 0
            max_tokens: 300,
        });
        
        const content = response.choices[0].message.content.trim();
        
        // JSON 강제 추출 (안전 장치)
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
             return JSON.parse(content.substring(s, e + 1));
        }
        // 파싱 실패 시 텍스트만 반환
        return { decision: "판단 불가", reason: content };

    } catch (e) {
        return { decision: "오류", reason: "AI 판단 중 오류가 발생했습니다." };
    }
}

// 9. API 핸들러 (최종 통합)
async function apiSummaryHandler(req, res) {
    try {
        const addr = req.body.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });

        // 1. Juso 검색
        const addressInfo = await searchAddress(addr);
        if (!addressInfo) return res.status(404).json({ error: "주소 검색 실패" });

        // 2. 병렬 조회
        const [molitItems, elevatorResult] = await Promise.all([
            fetchBuildingRegister(addressInfo).catch(() => []),
            searchElevatorWithFallbackNames(addressInfo).catch(() => ({ count: 0, items: [] }))
        ]);

        // 3. 데이터 요약
        const molitSummary = buildMolitSummary(molitItems);
        const bestElevator = findBestMatchingElevator(addressInfo.buldNm, elevatorResult.items);
        const elevatorSummary = getElevatorSummary(bestElevator ? [bestElevator] : []);

        // 4. Fallback 여부
        const isFallback = (molitSummary.totalCount === 0) || (molitSummary.maxFloor === 0 && molitSummary.gaMokArea === 0);
        
        if (isFallback && elevatorResult.count === 0) {
             return res.status(404).json({ error: "건축물 정보 없음", detail: "조회된 데이터가 없습니다." });
        }

        // 5. 1차 판단 (Node.js - 법적 기준)
        const gradeInfo = determineSafetyGrade(molitSummary, elevatorSummary, isFallback);
        
        // 6. 2차 판단 (LLM - AI 분석)
        const llmResult = await llmJudgment(molitSummary, elevatorSummary);

        // 7. 응답 생성
        res.json({
            status: "ok",
            uiRender: {
                badgeText: gradeInfo.badge,
                colorTheme: gradeInfo.colorTheme,
                mainTitle: gradeInfo.title,
                // LLM의 설명을 메인 설명으로 사용
                description: llmResult.reason 
            },
            analysis: {
                ruleBased: (gradeInfo.code === 'RED') ? '다중이용건축물' : '일반건축물', // Node.js 판단
                llmFinalDecision: llmResult.decision, // LLM 판단
                llmReason: llmResult.reason
            },
            data: {
                address: addressInfo.roadAddr,
                molit: { floor: molitSummary.maxFloor, area: molitSummary.gaMokArea },
                elevator: { floor: elevatorSummary.maxFloor, count: elevatorResult.count },
                source: isFallback ? "승강기 정보 (FALLBACK)" : "건축물대장 (MOLIT)"
            },
            raw: { molit: molitSummary.items, elevator: bestElevator }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
    }
}

// ... (라우팅 및 실행 코드는 동일)
app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));

