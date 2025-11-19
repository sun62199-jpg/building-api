// 1. 기본 세팅 (Version 3.0_251119 20시59분)
const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3 (CommonJS 호환)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// OpenAI CommonJS 방식
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 환경변수 확인
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ELEVATOR_KEY = process.env.ELEVATOR_KEY || MOLIT_KEY;

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY || !ELEVATOR_KEY) {
  console.warn(
    "⚠️ 환경변수 부족: JUSO_KEY, MOLIT_KEY, OPENAI_KEY, ELEVATOR_KEY 확인 필요"
  );
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
    confmKey: JUSO_KEY,
    currentPage: "1",
    countPerPage: "5",
    keyword: input,
    resultType: "json",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Juso API 오류: ${res.status}`);

  const data = await res.json();
  if (!data.results || data.results.common.errorCode !== "0") {
    throw new Error(`Juso 검색 실패: ${data.results?.common?.errorMessage}`);
  }

  const juso = data.results.juso[0];
  if (!juso) return null;

  return {
    sigunguCd: juso.admCd.substring(0, 5),
    bjdongCd: juso.admCd.substring(5, 10),
    bun: String(juso.lnbrMnnm || "").padStart(4, "0"),
    ji: String(juso.lnbrSlno || "").padStart(4, "0"),
    jibun: `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`,
    roadAddr: juso.roadAddr,
    siNm: juso.siNm,
    sggNm: juso.sggNm,
    buldNm: juso.bdNm,
    rawJuso: juso,
  };
}

// 5-A. MOLIT API 관련 함수들
async function callMolitApiSingle(sigunguCd, bjdongCd, bun, ji) {
  const url = new URL(
    `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`
  );
  const params = {
    serviceKey: MOLIT_KEY,
    sigunguCd,
    bjdongCd,
    platGbCd: "0",
    bun,
    ji,
    _type: "json",
    numOfRows: "100",
    pageNo: "1",
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
  } catch (e) {
    return [];
  }
}

async function fetchBuildingRegister(addressInfo) {
  const { sigunguCd, bjdongCd, bun, ji } = addressInfo;
  const baseJi = Number(ji);
  const jiOffsets = [-2, -1, 0, 1, 2]; // 주변 지번 검색 범위

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

// 5-B. Elevator API 관련 함수들
function generateElevatorSearchNames(addressInfo) {
    const rawBuldNm = addressInfo.buldNm;
    if (!rawBuldNm || rawBuldNm.length < 2) return [];

    const cleanedFullNm = rawBuldNm.replace(/\s/g, '');
    const names = new Set([cleanedFullNm]);
    
    const matchDanji = cleanedFullNm.match(/(\d+단지)$/);
    if (matchDanji) names.add(matchDanji[1]); 
    
    const firstWord = rawBuldNm.split(/\s+/)[0];
    if (firstWord && firstWord !== cleanedFullNm) names.add(firstWord);

    const filterOut = [addressInfo.siNm, addressInfo.sggNm, addressInfo.siNm.replace(/도|시|특별시|광역시/g, ''), addressInfo.sggNm.replace(/시|군|구/g, '')];

    return Array.from(names).filter(name => name.length > 1 && !filterOut.includes(name));
}

async function fetchElevatorInfo(siNm, sggNm, buldNm) {
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM`);
    const params = {
        serviceKey: ELEVATOR_KEY,
        pageNo: "1", numOfRows: "100", _type: "json",
        sido: siNm, sigungu: sggNm, buld_nm: buldNm
    };
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
    } catch (e) {
        return { count: 0, items: [] };
    }
}

async function searchElevatorWithFallbackNames(addressInfo) {
    const searchNames = generateElevatorSearchNames(addressInfo);
    console.log(`[ELEVATOR] 검색어 시도: ${searchNames.join(', ')}`);

    for (const name of searchNames) {
        const result = await fetchElevatorInfo(addressInfo.siNm, addressInfo.sggNm, name);
        if (result.count > 0) {
            console.log(`[ELEVATOR] 성공: '${name}' (${result.count}건)`);
            return result; // Stop-and-Filter: 성공 시 즉시 반환
        }
    }
    return { count: 0, items: [] };
}

// 5-C. 유틸리티: 퍼지 매칭 및 요약
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

// 6. 데이터 필터링 및 요약 (MOLIT 전용)
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

    const daJungList = filteredItems.filter(it => 
        ["공동주택", "제2종근린생활시설", "문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"]
        .includes(it.mainPurpsCdNm) || (it.etcPurps && it.etcPurps.includes("근린생활시설"))
    );

    const maxFloor = daJungList.length ? Math.max(...daJungList.map(it => Number(it.grndFlrCnt) || 0)) : 0;
    
    const gaMokArea = daJungList
        .filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm))
        .reduce((sum, it) => sum + Number(it.totArea), 0);

    const gaMokType = daJungList.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));

    return {
        totalCount: filteredItems.length,
        daJungCount: daJungList.length,
        maxFloor: maxFloor,
        gaMokArea: gaMokArea,
        gaMokType: gaMokType ? gaMokType.mainPurpsCdNm : null,
        items: daJungList
    };
}

// 7. ⚖️ 이원화 판단 로직 (Core Logic)
function isMultiUseBuilding(molitSummary, elevatorSummary) {
    const THRESHOLD_AREA = 5000;
    const THRESHOLD_FLOOR = 16;

    // 1. 가목 판단: 오직 MOLIT 데이터만 사용
    const isGaMok = molitSummary.gaMokArea >= THRESHOLD_AREA;

    // 2. 나목 판단: MOLIT와 승강기 중 더 높은 층수 사용
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
        gptReasonData = { 결과: "아니오", 기준: "미해당" };
    }

    return {
        isMultiUse: isGaMok || isNaMok,
        gptReasonData
    };
}

// 8. LLM 문장 생성 (안정화 버전)
async function llmJudgment(ruleResult) {
    const { gptReasonData } = ruleResult;
    const prompt = `
    데이터: ${JSON.stringify(gptReasonData)}
    규칙: 
    1. 결과가 '예'이면: "이 건물은 [기준] ([용도], [면적]㎡)에 해당하거나, [층수]층(나목) 이상이므로 다중이용건축물입니다." 형식으로 작성.
    2. 결과가 '아니오'이면: "이 건물은 기준(면적 5000㎡ 이상 또는 16층 이상)에 미달하여 해당하지 않습니다." 작성.
    3. 승강기 데이터 언급이 있으면 "참고로 승강기 정보를 반영하여 층수를 판단했습니다." 추가.
    4. JSON 형식으로만 응답: {"result": "예/아니오", "reason": "문장"}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0,
            max_tokens: 300,
        });
        
        const content = response.choices[0].message.content.trim();
        // JSON 강제 추출
        const jsonStr = content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1);
        
        return JSON.parse(jsonStr);
    } catch (e) {
        // LLM 실패 시 정적 응답
        return {
            result: gptReasonData.결과,
            reason: `AI 응답 오류. 시스템 판단: ${gptReasonData.결과} (기준: ${gptReasonData.기준})`
        };
    }
}

// 9. API 핸들러 (병렬 실행)
async function apiSummaryHandler(req, res) {
    try {
        const addr = req.body.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });

        // 1. 주소 검색
        const addressInfo = await searchAddress(addr);
        if (!addressInfo) return res.status(404).json({ error: "주소 검색 실패" });

        // 2. 🚀 병렬 조회 (MOLIT & Elevator)
        const [molitItems, elevatorResult] = await Promise.all([
            fetchBuildingRegister(addressInfo).catch(e => { console.error(e); return []; }),
            searchElevatorWithFallbackNames(addressInfo).catch(e => { console.error(e); return { count: 0, items: [] }; })
        ]);

        // 3. 데이터 요약
        const molitSummary = buildMolitSummary(molitItems);
        
        const bestElevator = findBestMatchingElevator(addressInfo.buldNm, elevatorResult.items);
        const elevatorSummary = getElevatorSummary(bestElevator ? [bestElevator] : []);

        // 4. 🛑 유효 데이터 없음 처리 (둘 다 실패 시)
        if (molitSummary.totalCount === 0 && elevatorSummary.maxFloor === 0) {
            return res.status(404).json({
                error: "건축물 정보를 찾을 수 없습니다.",
                detail: "건축물대장 및 승강기 정보 모두 조회되지 않았습니다."
            });
        }

        // 5. 최종 판단 (이원화 로직)
        const ruleResult = isMultiUseBuilding(molitSummary, elevatorSummary);
        
        // 6. LLM 생성
        const llmResult = await llmJudgment(ruleResult);

        // 7. 응답
        res.json({
            status: "ok",
            addressInfo: { roadAddr: addressInfo.roadAddr, jibun: addressInfo.jibun },
            analysis: {
                llmFinalDecision: llmResult.result,
                llmReason: llmResult.reason
            },
            summaryDetails: {
                총건물수: molitSummary.totalCount,
                최고지상층수: molitSummary.maxFloor,
                가목_연면적_합계: molitSummary.gaMokArea,
                가목_대표_용도: molitSummary.gaMokType,
                elevatorCount: elevatorResult.count,
                elevatorMaxFloor: elevatorSummary.maxFloor,
                다중이용건물: molitSummary.items // 상세 보기용
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
