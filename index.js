// 1. 기본 세팅 (Version 4.0_251121 16시22분)
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
// 🚨 JUSO_KEY는 제거되고 VWORLD_KEY가 사용됩니다.
const VWORLD_KEY = process.env.VWORLD_KEY;
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

// 4. 🆕 V-World 주소 검색 (PNU 기반 정확한 코드 획득)
async function searchAddress(input) {
  console.log(`[V-WORLD] 검색 시도: ${input}`);
  
  const url = new URL("https://api.vworld.kr/req/search");
  const params = {
    service: "search",
    request: "search",
    version: "2.0",
    crs: "EPSG:4326",
    size: "10",
    page: "1",
    query: input,
    type: "address",
    category: "road",
    format: "json",
    errorformat: "json",
    key: VWORLD_KEY // 🚨 환경 변수 사용
  };
  
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  try {
    const res = await fetch(url.toString());
    const data = await res.json();

    if (data.response?.status !== "OK") {
        console.warn(`[V-WORLD WARN] 검색 실패: ${data.response?.error?.text || '결과 없음'}`);
        return null;
    }

    // 가장 정확도 높은 첫 번째 결과 사용
    const item = data.response.result.items[0];
    if (!item) return null;

    // 🚨 PNU 코드 파싱 (19자리: 시군구5 + 법정동5 + 대지1 + 본번4 + 부번4)
    const pnu = item.id; 
    if (!pnu || pnu.length < 19) {
        console.error(`[V-WORLD ERROR] 유효하지 않은 PNU 코드: ${pnu}`);
        return null;
    }

    const sigunguCd = pnu.substring(0, 5);
    const bjdongCd = pnu.substring(5, 10);
    const landType = pnu.substring(10, 11);
    const bun = pnu.substring(11, 15);
    const ji = pnu.substring(15, 19);

    // V-World(1:대지, 2:산) -> MOLIT(0:대지, 1:산) 변환
    const platGbCd = landType === '2' ? '1' : '0';

    // 건물명 및 주소 텍스트 추출
    const roadAddr = item.address?.road || input;
    const jibunAddr = item.address?.parcel || "";
    
    // 시/군/구 및 건물명 추출 (승강기 API용)
    const addrParts = roadAddr.split(" ");
    const siNm = addrParts[0] || "";
    const sggNm = addrParts[1] || "";
    
    // 건물명 추출 로직 (괄호 안 내용 우선)
    let buldNm = "";
    const match = roadAddr.match(/\(([^)]+)\)/);
    if (match) {
        const parts = match[1].split(",");
        // 동 이름(예: 덕계동)을 제외하고 건물명만 추출 시도
        for (let part of parts) {
            part = part.trim();
            if (!part.endsWith("동") && !part.endsWith("가") && !part.match(/^\d/)) {
                buldNm = part;
            }
        }
        // 괄호 안에 적절한 게 없으면 마지막 부분 사용
        if (!buldNm) buldNm = parts[parts.length - 1].trim();
    }
    if (!buldNm) buldNm = input; // 최후의 수단

    console.log(`[V-WORLD] PNU 파싱: ${sigunguCd}-${bjdongCd}-${bun}-${ji} / 건물명: ${buldNm}`);

    return {
      sigunguCd, bjdongCd, bun, ji, platGbCd,
      roadAddr, jibun: jibunAddr,
      siNm, sggNm, buldNm,
      rawJuso: item
    };

  } catch (e) {
    console.error(`[V-WORLD] 호출 에러: ${e.message}`);
    return null;
  }
}

// 5-A. MOLIT API (PNU 덕분에 지번 확장이 덜 필요하지만 안전장치로 유지)
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
  
  // PNU가 정확하므로 기본 지번 우선 조회
  // 만약을 위해 ±1 범위만 아주 좁게 스캔
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

// 5-B. Elevator API 관련 함수들 (건물명 파편화 & Stop-and-Filter)
function generateElevatorSearchNames(addressInfo) {
    const rawBuldNm = addressInfo.buldNm;
    if (!rawBuldNm || rawBuldNm.length < 2) return [];

    const cleanedFullNm = rawBuldNm.replace(/\s/g, '');
    const names = new Set([cleanedFullNm]);
    
    const matchDanji = cleanedFullNm.match(/(\d+단지)$/);
    if (matchDanji) names.add(matchDanji[1]); 
    
    const firstWord = rawBuldNm.split(/\s+/)[0];
    if (firstWord && firstWord !== cleanedFullNm) names.add(firstWord);

    const filterOut = [
        addressInfo.siNm, addressInfo.sggNm, 
        addressInfo.siNm.replace(/도|시|특별시|광역시/g, ''), 
        addressInfo.sggNm.replace(/시|군|구/g, '')
    ];

    return Array.from(names).filter(name => name.length > 1 && !filterOut.includes(name));
}

async function fetchElevatorInfo(siNm, sggNm, buldNm) {
    // 🚨 B553664 서비스 ID 사용
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
            return result; // Stop-and-Filter
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
    const maxFloor = Math.max(...elevatorItems.map(item => Number(item.divGroundFloorCnt) || 0));
    return { maxFloor };
}

// 6. 데이터 필터링 및 요약
function buildMolitSummary(items) {
    const filteredItems = items.filter(it => {
        const purpCode = it.mainPurpsCd?.trim() || '';
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;

        // 0층/0면적 데이터 제거 (단, 16층 이상은 유효)
        if ((totArea === 0 || grndFlrCnt === 0) && grndFlrCnt < 16) return false;
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

// 7. 이원화 판단 로직
function isMultiUseBuilding(molitSummary, elevatorSummary) {
    const THRESHOLD_AREA = 5000;
    const THRESHOLD_FLOOR = 16;

    // 가목: 오직 MOLIT 기준
    const isGaMok = molitSummary.gaMokArea >= THRESHOLD_AREA;

    // 나목: MOLIT vs 승강기 중 높은 층수
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

// 8. LLM 문장 생성 (JSON 강제 추출 적용)
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
            temperature: 0.0,
            max_tokens: 300,
        });
        
        const content = response.choices[0].message.content.trim();
        // JSON 강제 추출
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if(s !== -1 && e !== -1) {
             return JSON.parse(content.substring(s, e+1));
        }
        return { result: gptReasonData.결과, reason: content }; // Fallback text
    } catch (e) {
        return { result: gptReasonData.결과, reason: `AI 응답 오류. 시스템 판단: ${gptReasonData.결과}` };
    }
}

// 9. API 핸들러 (병렬 실행)
async function apiSummaryHandler(req, res) {
    try {
        const addr = req.body.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });

        // 1. V-WORLD 주소 검색 (PNU)
        const addressInfo = await searchAddress(addr);
        if (!addressInfo) return res.status(404).json({ error: "주소 검색 실패" });

        // 2. 병렬 조회 (MOLIT & Elevator)
        const [molitItems, elevatorResult] = await Promise.all([
            fetchBuildingRegister(addressInfo).catch(e => { console.error(e); return []; }),
            searchElevatorWithFallbackNames(addressInfo).catch(e => { console.error(e); return { count: 0, items: [] }; })
        ]);

        // 3. 데이터 요약
        const molitSummary = buildMolitSummary(molitItems);
        const bestElevator = findBestMatchingElevator(addressInfo.buldNm, elevatorResult.items);
        const elevatorSummary = getElevatorSummary(bestElevator ? [bestElevator] : []);

        // 4. 유효 데이터 없음 처리
        const summaryIsZero = (molitSummary.maxFloor === 0) && (molitSummary.gaMokArea === 0);
        if (summaryIsZero && elevatorSummary.maxFloor === 0) {
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
