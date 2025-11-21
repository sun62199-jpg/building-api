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

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY || !ELEVATOR_KEY) {
  console.warn("⚠️ 필수 환경변수 누락: JUSO_KEY, MOLIT_KEY, OPENAI_KEY 확인 필요");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 4. JUSO 주소 검색
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
        let data; try { data = JSON.parse(text); } catch { return { count: 0, items: [] }; }
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
    
    // 🚨 최고층수: 용도 불문하고 전체 데이터에서 계산
    const maxFloor = filtered.length ? Math.max(...filtered.map(it => Number(it.grndFlrCnt) || 0)) : 0;

    const daJungList = filtered.filter(it => ["공동주택", "제2종근린생활시설", "문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));
    const gaMokArea = daJungList.filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm)).reduce((sum, it) => sum + Number(it.totArea), 0);
    const gaMokType = daJungList.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));

    return { totalCount: filtered.length, maxFloor, gaMokArea, gaMokType: gaMokType?.mainPurpsCdNm || null, items: daJungList };
}

// ============================================================
// 7. 안전 등급 결정 (Node.js)
// ============================================================
function determineSafetyGrade(molitSummary, elevatorSummary, isFallback) {
    const THRESHOLD_AREA = 5000;
    const THRESHOLD_FLOOR = 16;

    const finalMaxFloor = Math.max(molitSummary?.maxFloor || 0, elevatorSummary?.maxFloor || 0);
    const gaMokArea = molitSummary?.gaMokArea || 0;
    const hasElevatorData = elevatorSummary.maxFloor > 0;
    const assumedElevator = (molitSummary.totalCount > 0 && finalMaxFloor >= 2);
    
    const isGaMok = gaMokArea >= THRESHOLD_AREA;
    const isNaMok = finalMaxFloor >= THRESHOLD_FLOOR;

    // [RED] 특수 관리 (12시간) - 다중이용 또는 16층 이상
    if (isGaMok || isNaMok) {
        // 🚨 핵심: LLM에게 헷갈리지 말라고 '정확한 이유(Trigger)'를 텍스트로 전달
        let triggerReason = "";
        if (isGaMok) triggerReason = `가목 기준(용도: ${molitSummary.gaMokType}, 면적: ${gaMokArea}㎡)을 충족`;
        else triggerReason = `나목 기준(16층 이상, 실제 ${finalMaxFloor}층)을 충족`;

        return {
            code: 'RED',
            badge: '교육 대상',
            colorTheme: 'red', // 🚨 무조건 Red
            title: '비상구출운전 승강기관리교육(12시간)',
            reason_type: isGaMok ? '다중이용건축물(가목)' : '16층 이상(나목)',
            // LLM에게 전달할 명확한 힌트
            llm_hint: `이 건물은 ${triggerReason}하여 다중이용건축물(특수 관리 대상)입니다. 면적이 0이라도 16층 이상이면 특수 관리 대상입니다.`,
            desc_prefix: isGaMok ? `가목 용도 면적(${gaMokArea}㎡) 기준을 초과하여 특수 관리 대상입니다.` : `16층 이상(${finalMaxFloor}층) 건축물이므로 특수 관리 대상입니다.`
        };
    }

    // [BLUE] 일반 관리 (4시간)
    if (hasElevatorData || assumedElevator) {
         return {
            code: 'BLUE',
            badge: '교육 대상',
            colorTheme: 'blue', // 🚨 무조건 Blue
            title: '승강기 관리교육(4시간)',
            reason_type: '일반건축물(승강기 보유)',
            llm_hint: `이 건물은 다중이용건축물 기준에는 미치지 못하지만, 승강기가 있어 일반 관리 교육 대상입니다.`,
            desc_prefix: '16층 미만이지만 승강기가 설치되어 있어 일반 관리 교육 대상입니다.'
        };
    }

    // [GRAY] 대상 아님
    return {
        code: 'GRAY',
        badge: '대상 아님',
        colorTheme: 'gray',
        title: '교육 의무 없음',
        reason_type: '대상 아님',
        llm_hint: '교육 의무가 없습니다.',
        desc_prefix: '1층 이하의 건물이거나 승강기가 없어 교육 대상이 아닙니다.'
    };
}

// 8. LLM 설명 생성 (프롬프트 강화)
async function generateLLMDescription(gradeInfo, molitSummary, elevatorSummary) {
    const prompt = `
    [역할] 건축물 안전관리 교육 안내 전문가
    [데이터]
    - 최종판단: ${gradeInfo.title}
    - 결정이유: ${gradeInfo.llm_hint} (이 이유를 반드시 인용할 것!)
    - 상세정보: 건축물대장(최고 ${molitSummary.maxFloor}층, 가목면적 ${molitSummary.gaMokArea}㎡), 승강기정보(최고 ${elevatorSummary.maxFloor}층).
    
    [지시사항]
    위 '결정이유'를 바탕으로 사용자에게 결과의 이유를 친절하게 설명하는 한 문장을 작성하세요.
    주의: 면적이 0㎡라도 16층 이상이면 다중이용건축물이므로, 면적이 부족하다는 말은 하지 마세요.
    
    [출력] JSON 형식: {"message": "설명 문장"}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }],
            temperature: 0.0, max_tokens: 300,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(content.substring(s, e + 1)).message;
        return gradeInfo.desc_prefix; 
    } catch (e) { return gradeInfo.desc_prefix; }
}

// 9. API 핸들러
async function apiSummaryHandler(req, res) {
    try {
        const addr = req.body.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });

        const addressInfo = await searchAddress(addr);
        if (!addressInfo) return res.status(404).json({ error: "주소 검색 실패" });

        const [molitItems, elevatorResult] = await Promise.all([
            fetchBuildingRegister(addressInfo).catch(() => []),
            searchElevatorWithFallbackNames(addressInfo).catch(() => ({ count: 0, items: [] }))
        ]);

        const molitSummary = buildMolitSummary(molitItems);
        const bestElevator = findBestMatchingElevator(addressInfo.buldNm, elevatorResult.items);
        const elevatorSummary = getElevatorSummary(bestElevator ? [bestElevator] : []);

        const isFallback = (molitSummary.totalCount === 0) || (molitSummary.maxFloor === 0 && molitSummary.gaMokArea === 0);
        
        if (isFallback && elevatorResult.count === 0) {
             return res.status(404).json({ error: "건축물 정보 없음", detail: "데이터 조회 실패" });
        }

        const gradeInfo = determineSafetyGrade(molitSummary, elevatorSummary, isFallback);
        const llmDescription = await generateLLMDescription(gradeInfo, molitSummary, elevatorSummary);

        res.json({
            status: "ok",
            uiRender: {
                badgeText: gradeInfo.badge,
                colorTheme: gradeInfo.colorTheme,
                mainTitle: gradeInfo.title,
                description: llmDescription
            },
            analysis: {
                ruleBased: gradeInfo.code, // RED, BLUE, GRAY ...
                llmFinalDecision: (gradeInfo.code === 'RED') ? '예' : '아니오',
                llmReason: llmDescription
            },
            data: {
                address: addressInfo.roadAddr,
                molit: { floor: molitSummary.maxFloor, area: molitSummary.gaMokArea },
                elevator: { floor: elevatorSummary.maxFloor, count: elevatorResult.count },
                source: isFallback ? "승강기 정보 (FALLBACK)" : "건축물대장 (MOLIT)"
            },
            summaryDetails: {
                ...molitSummary,
                elevatorCount: elevatorResult.count,
                elevatorMaxFloor: elevatorSummary.maxFloor,
                elevatorSource: bestElevator ? '승강기 정보 있음' : '승강기 정보 없음',
                daJungList: molitSummary.items
            },
            raw: { molit: molitSummary.items, elevator: bestElevator }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
    }
}

app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
