// 1. 기본 세팅 (Version 5_251121 17시32분)
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
  console.warn("⚠️ 환경변수 부족: JUSO_KEY, MOLIT_KEY, OPENAI_KEY 확인 필요");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 4. JUSO 주소 검색
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
  } catch (e) { return null; }
}

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
    names.add(cleanedFullNm);
    const matchDanji = cleanedFullNm.match(/(\d+단지)$/);
    if (matchDanji) names.add(matchDanji[1]); 
    const firstWord = rawBuldNm.split(/\s+/)[0];
    if (firstWord && firstWord !== cleanedFullNm) names.add(firstWord);
    
    const filterOut = [addressInfo.siNm, addressInfo.sggNm, addressInfo.siNm.replace(/도|시|특별시|광역시/g, ''), addressInfo.sggNm.replace(/시|군|구/g, '')];
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

// 유틸리티
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

// 6. MOLIT 요약 (수정됨!)
function buildMolitSummary(items) {
    const filteredItems = items.filter(it => {
        const purpCode = it.mainPurpsCd?.trim() || ''; 
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;
        if ((totArea === 0 || grndFlrCnt === 0) && grndFlrCnt < 16) return false;
        if (purpCode === '17000' || purpCode === '21000') return false;
        return true;
    });

    // 🚨 수정: 용도 불문하고 전체 건물 목록에서 최고층수 계산
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
        maxFloor: maxFloor, // 🚨 수정됨
        gaMokArea: gaMokArea,
        gaMokType: gaMokType ? gaMokType.mainPurpsCdNm : null,
        items: daJungList
    };
}

// 7. ⚖️ 이원화 판단 로직
function isMultiUseBuilding(molitSummary, elevatorSummary) {
    const THRESHOLD_AREA = 5000;
    const THRESHOLD_FLOOR = 16;

    const isGaMok = molitSummary.gaMokArea >= THRESHOLD_AREA;
    
    // 나목: MOLIT와 승강기 중 더 높은 층수 사용
    const molitFloor = molitSummary.maxFloor;
    const elevFloor = elevatorSummary.maxFloor;
    const realMaxFloor = Math.max(molitFloor, elevFloor);
    const isNaMok = realMaxFloor >= THRESHOLD_FLOOR;

    let gptReasonData = {};
    
    if (isGaMok) {
        gptReasonData = { 결과: "예", 기준: "가목", 용도: molitSummary.gaMokType, 면적: molitSummary.gaMokArea };
    } else if (isNaMok) {
        gptReasonData = { 
            결과: "예", 기준: "나목", 층수: realMaxFloor, 
            비고: elevFloor > molitFloor ? "승강기 데이터 우선 적용" : "건축물대장 기준"
        };
    } else {
        gptReasonData = { 결과: "아니오", 기준: "미해당", 층수: realMaxFloor, 면적: molitSummary.gaMokArea };
    }

    return {
        daJung: isGaMok || isNaMok,
        gptReasonData
    };
}

// 8. LLM
async function llmJudgment(ruleResult) {
    const { gptReasonData } = ruleResult;
    const prompt = `
    데이터: ${JSON.stringify(gptReasonData)}
    규칙: 결과가 '예'면 이유 설명, '아니오'면 "기준(면적 5000㎡ 이상 또는 16층 이상) 미달" 이유 설명. JSON {"result": "예/아니오", "reason": "문장"} 출력.
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }], temperature: 0.0, max_tokens: 300,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if(s !== -1 && e !== -1) {
            try { return JSON.parse(content.substring(s, e+1)); } catch {}
        }
        return { result: gptReasonData.결과, reason: content };
    } catch (e) {
        return { result: gptReasonData.결과, reason: `AI 응답 오류. 시스템 판단: ${gptReasonData.결과}` };
    }
}

// 8.2 LLM Elevator
async function llmElevatorJudgment(summary) {
    const result = summary.isMultiUse ? "예" : "아니오";
    const prompt = `승강기 데이터: 최고 ${summary.maxFloor}층. 결과: ${result}. 규칙: 16층 이상 여부 설명. 대장 미조회 언급. JSON {"result": "${result}", "reason": "문장"} 출력.`;
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }], temperature: 0.0, max_tokens: 300,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if(s !== -1 && e !== -1) {
             try { return JSON.parse(content.substring(s, e+1)); } catch {}
        }
        return { result: result, reason: content };
    } catch (e) {
        return { result: result, reason: "승강기 정보 기반 판단입니다. (대장 미조회)" };
    }
}

// 9. API 핸들러 (병렬 실행 + 강제 병합)
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

        // 🚨 실질적 Zero Data 감지 (건축물대장 층수도 0이고 면적도 0인 경우)
        const summaryIsZero = (molitSummary.maxFloor === 0) && (molitSummary.gaMokArea === 0);

        // CASE 1: MOLIT Success (데이터 유효)
        // 🚨 수정: summaryIsZero 조건에 예외(elevator 데이터 있음)를 두어 병합 유도 가능성 고려
        // 여기서는 MOLIT 데이터가 의미가 있어야 메인 경로로 감.
        if (molitSummary.totalCount > 0 && !summaryIsZero) {
            const ruleResult = isMultiUseBuilding(molitSummary, elevatorSummary);
            const llmResult = await llmJudgment(ruleResult);
            
            return res.json({
                status: "ok",
                addressInfo: { roadAddr: addressInfo.roadAddr, jibun: addressInfo.jibun },
                analysis: {
                    llmFinalDecision: llmResult.result,
                    llmReason: llmResult.reason
                },
                summaryDetails: {
                    ...molitSummary,
                    elevatorCount: elevatorResult.count,
                    elevatorMaxFloor: elevatorSummary.maxFloor,
                    elevatorSource: bestElevator ? '승강기 정보 반영됨' : '승강기 정보 없음 (MOLIT 기준 판단)',
                    daJungList: molitSummary.items
                }
            });
        } 
        
        // CASE 2: MOLIT Failure -> Elevator Only Fallback
        if (elevatorResult.count > 0 && bestElevator) {
            const llmResult = await llmElevatorJudgment(elevatorSummary);
            return res.json({
                status: "ok_fallback",
                addressInfo: { roadAddr: addressInfo.roadAddr, jibun: addressInfo.jibun },
                analysis: {
                    llmFinalDecision: llmResult.result,
                    llmReason: llmResult.reason
                },
                summaryDetails: {
                    isFallback: true,
                    elevatorCount: elevatorResult.count,
                    elevatorMaxFloor: elevatorSummary.maxFloor,
                    elevatorSource: "승강기 데이터 (FALLBACK)"
                }
            });
        }
        
        return res.status(404).json({ error: "건축물 정보 없음", detail: "조회된 데이터가 없습니다." });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 오류", detail: err.toString() });
    }
}

app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
