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


// ---------------------------------------------------------
// 4. JUSO 주소 검색
// ---------------------------------------------------------
async function searchAddress(input) {
  console.log(`[JUSO] 검색 시도: ${input}`);
  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  const params = {
    confmKey: JUSO_KEY, currentPage: "1", countPerPage: "5", keyword: input, resultType: "json",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    
    const data = await res.json();
    if (!data.results || data.results.common.errorCode !== "0") {
        console.warn(`[JUSO FAIL] ${data.results?.common?.errorMessage}`);
        return null;
    }

    const juso = data.results.juso[0];
    if (!juso) return null;

    const admCd = juso.admCd;
    return {
        sigunguCd: admCd.substring(0, 5),
        bjdongCd: admCd.substring(5, 10),
        bun: String(juso.lnbrMnnm || "").padStart(4, "0"),
        ji: String(juso.lnbrSlno || "").padStart(4, "0"),
        jibun: `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`,
        roadAddr: juso.roadAddr,
        siNm: juso.siNm, sggNm: juso.sggNm, buldNm: juso.bdNm,
        rawJuso: juso, 
    };
  } catch (e) {
      console.error(`[JUSO ERROR] ${e.message}`);
      return null;
  }
}

// ---------------------------------------------------------
// 5. 데이터 조회 (MOLIT & Elevator)
// ---------------------------------------------------------

// 5-A. MOLIT API
async function callMolitApiSingle(sigunguCd, bjdongCd, bun, ji) {
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`);
  const params = {
    serviceKey: MOLIT_KEY, sigunguCd, bjdongCd, platGbCd: "0", bun, ji, 
    _type: "json", numOfRows: "100", pageNo: "1"
  };
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
  const baseJi = Number(ji);
  // 주변 지번 검색 범위 설정
  const jiOffsets = [0, -1, 1, -2, 2]; 

  for (const offset of jiOffsets) {
    const targetJiNum = baseJi + offset;
    if (targetJiNum < 0 || targetJiNum > 9999) continue;
    const targetJi = String(targetJiNum).padStart(4, '0');

    const items = await callMolitApiSingle(sigunguCd, bjdongCd, bun, targetJi);
    if (items.length > 0) {
        console.log(`[MOLIT] 데이터 발견: ${bun}-${targetJi}`);
        return items;
    }
  }
  return [];
}

// 5-B. Elevator API
function generateElevatorSearchNames(addressInfo) {
    const rawBuldNm = addressInfo.buldNm;
    if (!rawBuldNm || rawBuldNm.length < 2) return [];

    const cleanedFullNm = rawBuldNm.replace(/\s/g, ''); 
    let names = new Set();
    
    names.add(cleanedFullNm); // 전체 이름
    const matchDanji = cleanedFullNm.match(/(\d+단지)$/);
    if (matchDanji) names.add(matchDanji[1]); // "15단지"
    
    const firstWord = rawBuldNm.split(/\s+/)[0];
    if (firstWord && firstWord !== cleanedFullNm) names.add(firstWord); // 첫 단어
    
    const filterOut = [
        addressInfo.siNm, addressInfo.sggNm, 
        addressInfo.siNm.replace(/도|시|특별시|광역시/g, ''), 
        addressInfo.sggNm.replace(/시|군|구/g, '')
    ];

    return Array.from(names).filter(name => name.length > 1 && !filterOut.includes(name));
}

async function fetchElevatorInfo(siNm, sggNm, buldNm) {
    if (!buldNm || !siNm) return { count: 0, items: [] };
    
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM`);
    const params = {
        serviceKey: ELEVATOR_KEY, pageNo: "1", numOfRows: "100", _type: "json",
        sido: siNm, sigungu: sggNm, buld_nm: buldNm
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    try {
        const res = await fetch(url.toString());
        const text = await res.text();
        if (!res.ok) return { count: 0, items: [] };
        
        let data;
        try { data = JSON.parse(text); } catch { return { count: 0, items: [] }; }

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
    console.log(`[ELEVATOR] 검색 시도: ${searchNames.join(', ')}`);

    for (const name of searchNames) {
        const result = await fetchElevatorInfo(addressInfo.siNm, addressInfo.sggNm, name);
        if (result.count > 0) {
            console.log(`[ELEVATOR] 성공: '${name}' (${result.count}건)`);
            return result; 
        }
    }
    return { count: 0, items: [] };
}

// 5-C. 유틸리티
function calculateSimilarity(str1, str2) {
    const s1 = (str1 || '').replace(/\s/g, '').toUpperCase();
    const s2 = (str2 || '').replace(/\s/g, '').toUpperCase();
    if (!s1 || !s2) return 0;
    let matches = 0;
    const len = Math.min(s1.length, s2.length);
    for(let i=0; i<len; i++) if(s1[i]===s2[i]) matches++;
    return matches / Math.max(s1.length, s2.length);
}

function findBestMatchingElevator(targetName, elevatorItems) {
    let bestMatch = null, maxScore = -1;
    const uniqueItems = Array.from(new Map(elevatorItems.map(item => [item.elevatorNo, item])).values());
    for (const item of uniqueItems) {
        const score = calculateSimilarity(targetName, item.buldNm);
        if (score > maxScore) { maxScore = score; bestMatch = item; }
    }
    return bestMatch;
}

function getElevatorSummary(elevatorItems) {
    if (!elevatorItems || elevatorItems.length === 0) return { maxFloor: 0 };
    const maxFloor = Math.max(...elevatorItems.map(item => Number(item.divGroundFloorCnt) || 0));
    return { maxFloor };
}

// 6. MOLIT 요약
function buildMolitSummary(items) {
    const filteredItems = items.filter(it => {
        const purpCode = it.mainPurpsCd?.trim() || ''; 
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;
        
        // 0층/0면적 데이터 제거 (단, 16층 이상은 유효)
        if ((totArea === 0 || grndFlrCnt === 0) && grndFlrCnt < 16) return false;
        // 공장/창고 코드 제거
        if (purpCode === '17000' || purpCode === '21000') return false;
        return true;
    });

    // 최고층수는 용도 불문 전체에서 계산
    const maxFloor = filteredItems.length ? Math.max(...filteredItems.map(it => Number(it.grndFlrCnt) || 0)) : 0;

    const daJungList = filteredItems.filter(it => 
        ["공동주택", "제2종근린생활시설", "문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"]
        .includes(it.mainPurpsCdNm) || (it.etcPurps && it.etcPurps.includes("근린생활시설"))
    );

    const gaMokArea = daJungList
        .filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm))
        .reduce((sum, it) => sum + Number(it.totArea), 0);
    
    const gaMokType = daJungList.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));

    return {
        totalCount: filteredItems.length,
        maxFloor: maxFloor,
        gaMokArea: gaMokArea,
        gaMokType: gaMokType ? gaMokType.mainPurpsCdNm : null,
        items: daJungList
    };
}

// ============================================================
// 7. ⚖️ [Server-Driven Logic] 안전 등급 결정 (Node.js)
// ============================================================
function determineSafetyGrade(molitSummary, elevatorSummary, isFallback) {
    const THRESHOLD_AREA = 5000;
    
    // 1. 데이터 통합 (보수적 기준: 더 큰 값 채택)
    const finalMaxFloor = Math.max(molitSummary?.maxFloor || 0, elevatorSummary?.maxFloor || 0);
    const gaMokArea = molitSummary?.gaMokArea || 0;
    
    // 승강기 실제 개수 확인
    // elevatorSummary는 getElevatorSummary 결과이므로 count 정보가 없음.
    // 따라서, 원본 리스트가 있는지 확인하거나 호출부에서 넘겨줘야 함.
    // 여기서는 호출부에서 별도로 처리된 elevatorCount를 사용한다고 가정.
    // (아래 apiSummaryHandler에서 elevatorCount를 별도로 전달)

    // 2. 기준 판단
    const isGaMok = gaMokArea >= THRESHOLD_AREA;
    const isNaMok = finalMaxFloor >= 16;
    
    // 3. 등급 결정 로직 (우선순위 순서대로)
    
    // [RED] 특수 관리 대상 (12시간)
    if (isGaMok || isNaMok) {
        return {
            code: 'RED',
            badge: '교육 대상',
            colorTheme: 'red',
            title: '비상구출운전 승강기관리교육(12시간)',
            reason_type: isGaMok ? '다중이용건축물(가목)' : '16층 이상(나목)',
            desc_prefix: '이 건물은 ' + (isGaMok ? `다중이용건축물 기준(${gaMokArea.toFixed(2)}㎡)` : `16층 이상(${finalMaxFloor}층)`) + '에 해당하므로 특수 관리 교육 대상입니다.'
        };
    }

    // [BLUE] 일반 관리 대상 (4시간)
    // 승강기 API 결과가 있거나(1대 이상), MOLIT에서 승강기 유무를 확인한 경우
    // 여기서는 승강기 API 조회 결과(elevatorSummary.maxFloor > 0 의미는 승강기가 있다는 것)를 사용
    if (elevatorSummary.maxFloor > 0) {
         return {
            code: 'BLUE',
            badge: '교육 대상',
            colorTheme: 'blue',
            title: '승강기 관리교육(4시간)',
            reason_type: '일반건축물(승강기 보유)',
            desc_prefix: '이 건물은 일반건축물이지만 승강기가 설치되어 있어 일반 관리 교육 대상입니다.'
        };
    }

    // [YELLOW] 확인 필요 (데이터상 승강기 없지만 2층 이상)
    if (finalMaxF = Math.max(molitSummary?.maxFloor || 0, 0) >= 2) {
        return {
            code: 'YELLOW',
            badge: '확인 필요',
            colorTheme: 'yellow',
            title: '⚠️ 승강기 설치 여부 확인 필요',
            reason_type: '데이터 불일치(2층 이상)',
            desc_prefix: `건축물대장상 ${finalMaxF}층 건물이지만 전산상 승강기 정보가 조회되지 않았습니다. 현장에 승강기가 있다면 교육이 필수입니다.`
        };
    }

    // [GRAY] 대상 아님
    return {
        code: 'GRAY',
        badge: '대상 아님',
        colorTheme: 'gray',
        title: '교육 의무 없음',
        reason_type: '1층 이하/승강기 미보유',
        desc_prefix: '1층 이하의 건물이거나 승강기가 없어 교육 대상이 아닙니다.'
    };
}

// 8. 🤖 LLM 통합 문장 생성 (Server-Driven Context)
async function generateLLMDescription(gradeInfo, molitSummary, elevatorSummary) {
    const prompt = `
    상황: 건물 안전관리 교육 대상 여부 안내.
    판단결과: ${gradeInfo.reason_type} (${gradeInfo.code} 등급).
    데이터: 건축물대장(최고 ${molitSummary.maxFloor}층, 가목면적 ${molitSummary.gaMokArea}㎡), 승강기정보(최고 ${elevatorSummary.maxFloor}층).
    기본설명: "${gradeInfo.desc_prefix}"
    
    요청: 위 기본설명을 바탕으로, 사용자에게 더 부드럽고 명확하게 안내하는 문장을 한 줄로 작성해줘. (JSON {"message": "..."})
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }],
            temperature: 0.0, max_tokens: 200,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        
        if (s !== -1 && e !== -1) {
             return JSON.parse(content.substring(s, e + 1)).message;
        }
        // 파싱 실패 시 기본 설명 사용
        return gradeInfo.desc_prefix; 
    } catch (e) {
        return gradeInfo.desc_prefix;
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

        // 4. Fallback 여부 판단 (MOLIT 데이터가 없으면 Fallback)
        const isFallback = (molitSummary.totalCount === 0) || (molitSummary.maxFloor === 0 && molitSummary.gaMokArea === 0);
        
        // 5. 🛑 유효 데이터 없음 (둘 다 꽝)
        if (isFallback && elevatorResult.count === 0) {
             return res.status(404).json({
                error: "건축물 정보 없음",
                detail: "건축물대장 및 승강기 정보가 모두 조회되지 않았습니다."
            });
        }

        // 6. ⚖️ 서버 주도 판단 (Server-Driven)
        // elevatorResult.count 정보도 넘겨주기 위해 수정된 함수 호출 필요하지만, 
        // 여기선 로직 내에서 처리: elevatorSummary에 count 정보가 없으므로 elevatorResult.count 사용
        
        // 등급 결정 (gradeInfo 생성)
        const gradeInfo = determineSafetyGrade(molitSummary, elevatorSummary, isFallback);
        
        // LLM 설명 생성
        const llmReason = await generateLLMDescription(gradeInfo, molitSummary, elevatorSummary);

        // 7. 응답 (UI 렌더링용 데이터 포함)
        res.json({
            status: "ok",
            uiRender: {
                badgeText: gradeInfo.badge,
                colorTheme: gradeInfo.colorTheme,
                mainTitle: gradeInfo.title,
                description: llmReason
            },
            data: {
                address: addressInfo.roadAddr,
                molit: { 
                    floor: molitSummary.maxFloor, 
                    area: molitSummary.gaMokArea,
                    count: molitSummary.totalCount 
                },
                elevator: { 
                    floor: elevatorSummary.maxFloor, 
                    count: elevatorResult.count 
                },
                source: isFallback ? "승강기 정보 (FALLBACK)" : "건축물대장 (MOLIT)"
            },
            raw: { 
                molit: molitSummary.items, 
                elevator: bestElevator 
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
    }
}

// 10. 라우팅
app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
