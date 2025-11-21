// 1. 기본 세팅 (Version 4.1_251121 16시34분)
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
// 🚨 JUSO_KEY 대신 VWORLD_KEY 사용 (표준 명세 적용)
const VWORLD_KEY = process.env.VWORLD_KEY || "AF6A175C-8C07-335C-87C2-09971E451820"; 
const MOLIT_KEY = process.env.MOLIT_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ELEVATOR_KEY = process.env.ELEVATOR_KEY || MOLIT_KEY; 

if (!VWORLD_KEY || !MOLIT_KEY || !OPENAI_KEY || !ELEVATOR_KEY) {
  console.warn(
    "⚠️ 환경변수 부족: VWORLD_KEY, MOLIT_KEY, OPENAI_KEY, ELEVATOR_KEY 확인 필요"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 4. 🆕 V-World 주소 검색 (표준 파라미터 적용)
async function searchAddress(input) {
  console.log(`[V-WORLD] 검색 시도: ${input}`);
  
  const url = new URL("https://api.vworld.kr/req/search");
  
  // 🚨 명세서에 따른 표준 파라미터 설정
  const params = {
    service: "search",
    request: "search",
    version: "2.0",
    crs: "EPSG:4326",
    size: "10",
    page: "1",
    query: input,
    type: "address",    // 🚨 필수: 주소 검색
    category: "road",   // 🚨 필수: 도로명 주소 우선
    format: "json",
    errorformat: "json",
    key: VWORLD_KEY
  };
  
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  try {
    const res = await fetch(url.toString());
    
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`V-World API HTTP Error ${res.status}: ${errText.substring(0, 100)}`);
    }

    const data = await res.json();

    // V-World 응답 상태 확인
    if (data.response?.status !== "OK") {
        console.warn(`[V-WORLD WARN] 검색 실패: ${data.response?.error?.text || '결과 없음'}`);
        return null;
    }

    // 가장 정확도 높은 첫 번째 결과 사용
    const item = data.response.result.items[0]; 
    if (!item) return null;

    // 🚨 PNU 코드 파싱 (id 필드가 PNU 19자리)
    const pnu = item.id; 
    
    if (!pnu || pnu.length < 19) {
        console.error(`[V-WORLD ERROR] 유효하지 않은 PNU 코드: ${pnu}`);
        return null;
    }

    // PNU 구조: 시군구(5) + 법정동(5) + 대지구분(1) + 본번(4) + 부번(4)
    const sigunguCd = pnu.substring(0, 5);
    const bjdongCd = pnu.substring(5, 10);
    const landType = pnu.substring(10, 11); 
    const bun = pnu.substring(11, 15);
    const ji = pnu.substring(15, 19);

    // MOLIT용 대지구분 변환 (V-World 1:대지, 2:산 -> MOLIT 0:대지, 1:산)
    const platGbCd = landType === '2' ? '1' : '0';

    // 주소 문자열 추출
    const roadAddr = item.address?.road || input;
    const jibunAddr = item.address?.parcel || "";
    
    // 건물명 추출 (bldnm 필드 우선, 없으면 파싱)
    let buldNm = item.address?.bldnm || "";
    
    if (!buldNm) {
        // 괄호 안의 내용 추출 시도 (예: "... (덕계동, 양주회천15단지)")
        const match = roadAddr.match(/\(([^)]+)\)/);
        if (match) {
            const parts = match[1].split(",");
            // 동 이름 제외하고 건물명만 추출
            for (let part of parts) {
                part = part.trim();
                // 숫자로 시작하거나 '동'으로 끝나지 않는 부분을 건물명으로 추정
                if (!part.endsWith("동") && !part.match(/^\d/)) {
                    buldNm = part;
                }
            }
            if (!buldNm) buldNm = parts[parts.length - 1].trim();
        }
    }
    if (!buldNm) buldNm = input; 

    // 시도/시군구 이름 추출 (승강기 API용)
    const addrParts = roadAddr.split(" ");
    const siNm = addrParts[0] || "";
    const sggNm = addrParts[1] || "";

    console.log(`[V-WORLD] PNU 파싱 완료: ${sigunguCd}-${bjdongCd}-${bun}-${ji} (${buldNm})`);

    return {
      sigunguCd, bjdongCd, bun, ji, platGbCd,
      roadAddr, jibun: jibunAddr,
      siNm, sggNm, buldNm,
      rawJuso: item
    };

  } catch (e) {
    console.error(`[V-WORLD] API 호출 에러: ${e.message}`);
    return null;
  }
}

// 5-A. MOLIT API 관련 함수들
async function callMolitApiSingle(sigunguCd, bjdongCd, bun, ji, platGbCd) {
  const url = new URL(
    `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`
  );
  const params = {
    serviceKey: MOLIT_KEY,
    sigunguCd, bjdongCd, bun, ji, 
    platGbCd: platGbCd || "0",
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
  } catch (e) {
    return [];
  }
}

async function fetchBuildingRegister(addressInfo) {
  const { sigunguCd, bjdongCd, bun, ji, platGbCd } = addressInfo;
  
  // V-World PNU는 정확하므로 기본 지번을 최우선으로 조회
  // 데이터 누락 대비 ±1 범위만 안전하게 스캔
  const baseJi = Number(ji);
  const jiOffsets = [0, -1, 1]; 

  for (const offset of jiOffsets) {
    const targetJiNum = baseJi + offset;
    if (targetJiNum < 0 || targetJiNum > 9999) continue;
    const targetJi = String(targetJiNum).padStart(4, '0');

    const items = await callMolitApiSingle(sigunguCd, bjdongCd, bun, targetJi, platGbCd);
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
    let names = new Set();
    
    // 1. 전체 이름 (띄어쓰기 제거)
    names.add(cleanedFullNm);
    
    // 2. 숫자+단지 (예: 15단지)
    const matchDanji = cleanedFullNm.match(/(\d+단지)$/);
    if (matchDanji) names.add(matchDanji[1]); 
    
    // 3. 첫 단어 (예: 양주회천)
    const firstWord = rawBuldNm.split(/\s+/)[0];
    if (firstWord && firstWord !== cleanedFullNm) names.add(firstWord);

    // 행정구역명 필터링 (오검색 방지)
    const filterOut = [
        addressInfo.siNm, addressInfo.sggNm, 
        addressInfo.siNm.replace(/도|시|특별시|광역시/g, ''), 
        addressInfo.sggNm.replace(/시|군|구/g, '')
    ];

    return Array.from(names).filter(name => name.length > 1 && !filterOut.includes(name));
}

async function fetchElevatorInfo(siNm, sggNm, buldNm) {
    if (!buldNm || !siNm) return { count: 0, items: [] };
    
    // B553664 서비스 사용
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

        let data;
        try { data = JSON.parse(text); } catch { return { count: 0, items: [] }; }

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
    console.log(`[ELEVATOR] 검색 시도: ${searchNames.join(', ')}`);

    for (const name of searchNames) {
        const result = await fetchElevatorInfo(addressInfo.siNm, addressInfo.sggNm, name);
        if (result.count > 0) {
            console.log(`[ELEVATOR] 성공: '${name}' (${result.count}건)`);
            return result; // Stop-and-Filter (첫 성공 시 중단)
        }
    }
    return { count: 0, items: [] };
}

// 5-C. 유틸리티 (퍼지 매칭)
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
    // divGroundFloorCnt 필드 사용
    const maxFloor = Math.max(...elevatorItems.map(item => Number(item.divGroundFloorCnt) || 0));
    return { maxFloor };
}

// 6. 데이터 필터링 및 요약
function buildMolitSummary(items) {
    const filteredItems = items.filter(it => {
        const purpCode = it.mainPurpsCd?.trim() || '';
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;

        // 불량 데이터 제거 (면적0 & 16층 미만)
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
        maxFloor: maxFloor,
        gaMokArea: gaMokArea,
        gaMokType: gaMokType ? gaMokType.mainPurpsCdNm : null,
        items: daJungList
    };
}

// 7. 이원화 판단 로직
function isMultiUseBuilding(molitSummary, elevatorSummary) {
    const THRESHOLD_AREA = 5000;
    const THRESHOLD_FLOOR = 16;

    // 가목: MOLIT 기준
    const isGaMok = molitSummary.gaMokArea >= THRESHOLD_AREA;

    // 나목: MAX(MOLIT, 승강기)
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
        daJung: isGaMok || isNaMok,
        gptReasonData
    };
}

// 8. LLM 문장 생성 (안정화)
async function llmJudgment(ruleResult) {
    const { gptReasonData } = ruleResult;
    const prompt = `
    데이터: ${JSON.stringify(gptReasonData)}
    규칙: 
    1. 결과가 '예'이면: "이 건물은 [기준] ([용도], [면적]㎡)에 해당하거나, [층수]층(나목) 이상이므로 다중이용건축물입니다."
    2. 결과가 '아니오'이면: "이 건물은 기준(면적 5000㎡ 이상 또는 16층 이상)에 미달하여 해당하지 않습니다."
    3. 승강기 데이터 언급이 있으면 "참고로 승강기 정보를 반영하여 층수를 판단했습니다." 추가.
    4. JSON 형식으로만 응답: {"result": "예/아니오", "reason": "문장"}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0, max_tokens: 300,
        });
        
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        
        if(s !== -1 && e !== -1) {
             return JSON.parse(content.substring(s, e+1));
        }
        // JSON 파싱 실패 시 원문 반환
        return { result: gptReasonData.결과, reason: content };
    } catch (e) {
        return { result: gptReasonData.결과, reason: `AI 응답 오류. 시스템 판단: ${gptReasonData.결과}` };
    }
}

// 9. API 핸들러 (병렬 실행)
async function apiSummaryHandler(req, res) {
    try {
        const addr = req.body.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });

        // 1. V-WORLD 주소 검색 (PNU 획득)
        const addressInfo = await searchAddress(addr);
        if (!addressInfo) return res.status(404).json({ error: "주소 검색 실패", detail: "V-World에서 주소를 찾을 수 없습니다." });

        // 2. 병렬 조회 (MOLIT & Elevator)
        const [molitItems, elevatorResult] = await Promise.all([
            fetchBuildingRegister(addressInfo).catch(() => []),
            searchElevatorWithFallbackNames(addressInfo).catch(() => ({ count: 0, items: [] }))
        ]);

        // 3. 데이터 요약
        const molitSummary = buildMolitSummary(molitItems);
        
        const bestElevator = findBestMatchingElevator(addressInfo.buldNm, elevatorResult.items);
        const elevatorSummary = getElevatorSummary(bestElevator ? [bestElevator] : []);

        // 4. 🛑 유효 데이터 없음 처리 (둘 다 실패 시)
        const summaryIsZero = (molitSummary.maxFloor === 0) && (molitSummary.gaMokArea === 0);
        
        if (summaryIsZero && elevatorSummary.maxFloor === 0) {
            return res.status(404).json({
                error: "건축물 정보 없음",
                detail: "건축물대장 및 승강기 정보가 모두 유효하지 않습니다."
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
                elevatorSource: bestElevator ? '승강기 정보 반영됨' : '승강기 정보 없음',
                다중이용건물: molitSummary.items
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


