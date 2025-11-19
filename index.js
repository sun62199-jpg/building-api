// 1. 기본 세팅 v2.9.1 251119
// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3(CommonJS에서 ESM 사용)
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

// 🚨 Elevator Key 추가 (필요)
const ELEVATOR_KEY = process.env.ELEVATOR_KEY || MOLIT_KEY; 

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY || !ELEVATOR_KEY) {
  console.warn(
    "⚠️ 환경변수가 부족합니다. JUSO_KEY, MOLIT_KEY, OPENAI_KEY, ELEVATOR_KEY 필요"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 4. JUSO 주소 검색 (법적 코드 및 승강기 조회용 이름 획득)
async function searchAddress(input) {
  console.log(`[JUSO DEBUG] 검색을 시도한 주소: ${input}`);
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
  if (!res.ok) throw new Error(`주소 검색 API 오류: HTTP ${res.status}`);

  const data = await res.json();
  if (!data.results || data.results.common.errorCode !== "0") {
    throw new Error(
      `주소 검색 실패: ${data.results?.common?.errorMessage || "알 수 없는 오류"}`
    );
  }

  const juso = data.results.juso[0];
  if (!juso) {
    console.warn(`[JUSO WARN] 검색 결과 없음: ${input}`);
    return null;
  }

  const admCd = juso.admCd;
  return {
    sigunguCd: admCd.substring(0, 5),
    bjdongCd: admCd.substring(5, 10),
    bun: String(juso.lnbrMnnm || "").padStart(4, "0"),
    ji: String(juso.lnbrSlno || "").padStart(4, "0"),
    jibun: `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`,
    roadAddr: juso.roadAddr,
    // 🚨 승강기 API에 필요한 정보 추가
    siNm: juso.siNm, 
    sggNm: juso.sggNm,
    buldNm: juso.bdNm,
    rawJuso: juso, 
  };
}

// 5.1 🚨 보조 함수: 단일 지번으로 MOLIT API 호출
async function callMolitApiSingle(sigunguCd, bjdongCd, bun, ji) {
  const endpoint = "getBrTitleInfo"; 

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
  
  const url = new URL(
    `https://apis.data.go.kr/1613000/BldRgstHubService/${endpoint}`
  );
  
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) throw new Error(`건축물대장 API 오류: HTTP ${res.status}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("건축물대장 JSON 파싱 실패 → " + text);
  }

  const header = data.response?.header;
  if (!header || header.resultCode !== "00") {
    return []; 
  }

  const rawItems = data.response?.body?.items?.item;
  if (!rawItems) return [];
  return Array.isArray(rawItems) ? rawItems : [rawItems];
}

// 5.2.1 🆕 승강기 정보 검색어 생성 함수 (최종 보강)
function generateElevatorSearchNames(addressInfo) {
    const rawBuldNm = addressInfo.buldNm;
    if (!rawBuldNm || rawBuldNm.length < 2) return [];

    const cleanedFullNm = rawBuldNm.replace(/\s/g, ''); // 띄어쓰기 제거한 전체 이름 (예: 양주회천15단지)
    const siNm = addressInfo.siNm;
    const sggNm = addressInfo.sggNm;

    let names = new Set();
    
    // 1. Full name (cleaned)
    names.add(cleanedFullNm);
    
    // 2. Last part containing number + '단지' (가장 효과적이었던 '15단지' 추출)
    const matchDanji = cleanedFullNm.match(/(\d+단지)$/);
    if (matchDanji) names.add(matchDanji[1]); 
    
    // 3. First word/prefix (예: 양주회천)
    const firstWord = rawBuldNm.split(/\s+/)[0];
    if (firstWord && firstWord !== cleanedFullNm) names.add(firstWord);
    
    // 4. 모든 단어 파편 추출
    rawBuldNm.split(/\s+/).forEach(part => {
        if (part && part.length >= 2) names.add(part);
    });

    // 🚨 최종 필터링: 행정구역명 제거
    const filterOutNames = [siNm, sggNm, siNm.replace(/도|시|특별시|광역시/g, ''), sggNm.replace(/시|군|구/g, '')];

    return Array.from(names).filter(name => {
        // 이름이 행정구역 명칭과 일치하면 제외 (예: '양주'를 제외)
        return name && name.length > 1 && !filterOutNames.includes(name);
    });
}


// 5.2.2 🆕 승강기 정보 파편화 조회 함수 (수정됨: 모든 결과 수집)
async function searchElevatorWithFallbackNames(addressInfo) {
    const searchNames = generateElevatorSearchNames(addressInfo);
    
    console.log(`[ELEVATOR-TRY] 건물명 파편화 조회 시도: ${searchNames.join(', ')}`);

    // 시도/시군구는 Juso 결과값 그대로 사용
    const { siNm, sggNm } = addressInfo;
    const allItems = []; // 모든 검색 결과를 누적할 배열
    let totalCount = 0;


    for (const name of searchNames) {
        // 5.2. fetchElevatorInfo를 호출 (엔드포인트는 B553664로 수정된 상태)
        const result = await fetchElevatorInfo(siNm, sggNm, name);
        
        if (result.count > 0) {
            console.log(`[ELEVATOR-SUCCESS-COLLECT] '${name}'로 ${result.count}건 검색 성공. 전체 수집 중.`);
            allItems.push(...result.items); // 결과를 배열에 추가
            totalCount += result.count;
            // 🚨 여기서 바로 반환하지 않고 다음 검색어로 넘어갑니다. (데이터 오염 방지)
        }
    }
    
    // 모든 검색어를 시도한 후, 전체 결과를 반환합니다.
    return { count: totalCount, items: allItems };
}


// 5.2 🆕 승강기 정보 조회 함수 (B553664 서비스 ID 사용)
async function fetchElevatorInfo(siNm, sggNm, buldNm) {
    if (!buldNm || !siNm) {
        return { count: 0, items: [] };
    }
    
    const ELEVATOR_KEY = process.env.ELEVATOR_KEY || MOLIT_KEY; 
    const ELEVATOR_BASE_URL = `https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM`;

    const params = {
        serviceKey: ELEVATOR_KEY, 
        pageNo: "1",
        numOfRows: "100",
        sido: siNm, 
        sigungu: sggNm, 
        buld_nm: buldNm,
        _type: "json",
    };

    const url = new URL(ELEVATOR_BASE_URL);

    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    try {
        const res = await fetch(url.toString());
        const text = await res.text(); 

        if (!res.ok) {
            console.error(`[ELEVATOR-ERROR] HTTP ${res.status} 오류: ${text.substring(0, 50)}...`);
            return { count: 0, items: [] };
        }
        
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error(`[ELEVATOR-ERROR] JSON 파싱 실패 (비정상 응답): ${text.substring(0, 100)}...`);
            return { count: 0, items: [] };
        }

        if (data.response?.header?.resultCode !== "00") {
             console.error(`[ELEVATOR-ERROR] API 논리 오류: ${data.response?.header?.resultMsg}`);
             return { count: 0, items: [] };
        }

        const count = Number(data.response?.body?.totalCount) || 0;
        const rawItems = data.response?.body?.items?.item;
        
        if (count === 0 || !rawItems) {
            return { count: 0, items: [] };
        }

        const items = Array.isArray(rawItems) ? rawItems : [rawItems];
        console.log(`[ELEVATOR-SUCCESS] ${count}개의 승강기 정보 발견.`);
        return { count, items };

    } catch (error) {
        console.error(`[ELEVATOR-ERROR] 네트워크 레벨 오류: ${error.message}`);
        return { count: 0, items: [] };
    }
}


// 5.3.1 🆕 퍼지 매칭 헬퍼 (유사도 계산)
function normalizeString(str) {
    return (str || '').replace(/\s/g, '').toUpperCase();
}

function calculateSimilarity(str1, str2) {
    const s1 = normalizeString(str1);
    const s2 = normalizeString(str2);
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0;

    let matchCount = 0;
    const minLength = Math.min(len1, len2);
    for (let i = 0; i < minLength; i++) {
        if (s1[i] === s2[i]) {
            matchCount++;
        }
    }
    return matchCount / Math.max(len1, len2); 
}

// 5.3.2 🆕 가장 유사한 항목 1개 선정
function findBestMatchingElevator(targetName, elevatorItems) {
    let bestMatch = null;
    let maxScore = -1;

    // 중복 제거 및 필터링
    const uniqueItems = Array.from(new Map(elevatorItems.map(item => [item.elevatorNo, item])).values());

    for (const item of uniqueItems) {
        // Elevator API의 건물명 필드(buldNm)를 사용한다고 가정
        const candidateName = item.buldNm; 
        const score = calculateSimilarity(targetName, candidateName);

        if (score > maxScore) {
            maxScore = score;
            bestMatch = item;
        }
    }
    return bestMatch;
}


// 5.4 🆕 승강기 정보 기반 요약 및 판단 함수 (Fallback 전용)
function getElevatorSummary(elevatorItems) {
    if (!elevatorItems || elevatorItems.length === 0) {
        return { isMultiUse: false, maxFloor: 0, reason: "승강기 정보 없음" };
    }

    // 승강기 정보 기반 판단은 16층 이상 (나목) 기준으로만 진행
    const maxFloor = Math.max(...elevatorItems.map(item => Number(item.divGroundFloorCnt) || 0));
    const isMultiUse = maxFloor >= 16;
    
    let reasonText = "";
    if (isMultiUse) {
        reasonText = `최고 지상층수 ${maxFloor}층 (나목 기준 충족)`;
    } else {
        reasonText = `최고 지상층수 ${maxFloor}층 (나목 기준 미달)`;
    }

    return {
        isMultiUse: isMultiUse,
        maxFloor: maxFloor,
        reason: reasonText
    };
}


// 5. 🔄 메인 함수: 주변 지번까지 확장하여 조회 시도 (MOLIT Primary)
async function fetchBuildingRegister(addressInfo) {
  const { sigunguCd, bjdongCd, bun, ji } = addressInfo;
  
  const baseJiNumber = Number(ji); 
  const currentBun = bun;

  // 조회할 부번 목록 생성 (기본: -2, -1, 0, 1, 2)
  const jiOffsets = [-2, -1, 0, 1, 2]; 

  let allItems = [];
  
  for (const offset of jiOffsets) {
    const targetJiNumber = baseJiNumber + offset;

    if (targetJiNumber < 0 || targetJiNumber > 9999) continue; 
    
    const targetJi = String(targetJiNumber).padStart(4, '0');

    console.log(`[MOLIT-MULTI] 지번 조회 시도: ${currentBun}-${targetJi}`);
    
    try {
      const items = await callMolitApiSingle(sigunguCd, bjdongCd, currentBun, targetJi);
      
      if (items.length > 0) {
        console.log(`[MOLIT-SUCCESS] ${currentBun}-${targetJi}에서 유효한 데이터 발견. 조회 중단.`);
        allItems.push(...items); 
        return allItems;
      }
    } catch (error) {
      throw new Error(`주변 지번 조회 중 치명적 오류: ${error.message}`);
    }
  }

  return allItems;
}


// 6. 한글화 & 요약 (Node.js 계산 및 내부 필터링)
function buildSummary(items) {
    const CURRENT_YEAR = new Date().getFullYear();
    
    // 🚨 1단계: 불완전 데이터 및 부적합 건물 1차 필터링
    const filteredItems = items.filter(it => {
        const purpName = it.mainPurpsCdNm?.trim() || ''; 
        const purpCode = it.mainPurpsCd?.trim() || ''; 
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;
        
        // --- (A) 치명적 불량 데이터 제거 (0층/0면적) ---
        // 총면적 0이거나 지상층수 0인데 16층 미만인 데이터는 무조건 제거
        if ((totArea === 0 || grndFlrCnt === 0) && grndFlrCnt < 16) { 
             return false;
        }

        // --- (B) 엉뚱한 용도 필터링 (다중이용건축물과 무관한 용도) ---
        const isFactoryOrWarehouseCode = purpCode === '17000' || purpCode === '21000';
        const isFactoryOrWarehouseName = purpName.includes('공장') || purpName.includes('창고') || purpName.includes('위험물');

        if (isFactoryOrWarehouseCode || isFactoryOrWarehouseName) {
            return false;
        }

        return true; 
    });
    
    // 🚨 2단계: 다중이용건축물 해당 용도만 필터링 (분석 데이터로 사용)
    const 다중이용건물 = filteredItems.filter( 
        (it) =>
            [
                "공동주택",
                "제2종근린생활시설",
                "문화 및 집회시설",
                "종교시설",
                "판매시설",
                "운수시설",
                "의료시설",
                "숙박시설",
            ].includes(it.mainPurpsCdNm) ||
            (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
    );
        
    // 🚨 3단계: 최종 기준 적용 (최고층, 가목 연면적 합계)
    const 최고지상층수 = 다중이용건물.length 
        ? Math.max(...다중이용건물.map(it => Number(it.grndFlrCnt) || 0)) 
        : 0;

    const 가목_연면적_합계 = 다중이용건물
        .filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm))
        .reduce((sum, item) => sum + Number(item.totArea), 0);
    
    const 가목_용도 = 다중이용건물.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));
    
    return {
        총건물수: filteredItems.length, // 1차 필터링 통과한 건물 수
        다중이용건물수: 다중이용건물.length, // 2차 필터링 통과한 건물 수
        최고지상층수: 최고지상층수,
        가목_연면적_합계: 가목_연면적_합계, 
        가목_대표_용도: 가목_용도 ? 가목_용도.mainPurpsCdNm : null, 
        다중이용건물: 다중이용건물.map((it) => ({
            용도: it.mainPurpsCdNm,
            지상층: Number(it.grndFlrCnt),
            연면적: Number(it.totArea)
        })),
    };
}

// 7. 룰 기반 판단 (GPT 문장 생성을 위한 최종 근거 데이터 포함)
function isMultiUseBuilding(summary) {
    const multiUseAreaThreshold = 5000;
    const 최고지상층수 = summary.최고지상층수 || 0;
    const 가목_합계 = summary.가목_연면적_합계 || 0;
    
    const 나목_해당 = 최고지상층수 >= 16;
    const 가목_해당 = 가목_합계 >= multiUseAreaThreshold;
    
    let GPT_판단_근거 = {};

    if (가목_해당) {
        GPT_판단_근거 = {
            결과: "예",
            판단_기준: "가목",
            가목_용도: summary.가목_대표_용도,
            가목_연면적: 가목_합계.toFixed(2)
        };
    } else if (나목_해당) {
        GPT_판단_근거 = {
            결과: "예",
            판단_기준: "나목",
            최고층: 최고지상층수
        };
    } else {
        GPT_판단_근거 = {
            결과: "아니오",
            판단_기준: "없음"
        };
    }

    const 결과 = 가목_해당 || 나목_해당;

    return {
        다중이용건축물: 결과,
        판단이유: 결과 
            ? `가목: ${가목_해당 ? '해당' : '없음'}, 나목: ${나목_해당 ? '해당' : '없음'}`
            : "가목·나목 해당 없음",
        GPT_근거: GPT_판단_근거
    };
}

// 8.1 LLM 판단 (MOLIT 결과 기반)
async function llmJudgment(ruleResult) { 
    const { GPT_근거 } = ruleResult;
    
    const prompt = `
주어진 JSON 데이터는 건축물의 다중이용건축물 여부를 서버가 최종 판단한 결과입니다.
당신의 역할은 이 결과를 바탕으로 정해진 형식의 '판단근거' 문장을 생성하는 것입니다.

**[GPT_근거 데이터]**
${JSON.stringify(GPT_근거, null, 2)}

**[판단 근거 작성 규칙]**
1.  '다중이용건축물' 키 값은 **GPT_근거.결과** 값을 그대로 사용한다.
2.  판단 근거는 아래 형식 중 **하나만을 사용**하여 단정적인 문장 하나로 구성한다.

    * **나목 해당 시 형식:** "이 건물은 ${GPT_근거.최고층}층 이므로 다중이용건축물에 해당됩니다."
    * **가목 해당 시 형식:** "이 건물은 다중이용건축물 기준 중 **${GPT_근거.가목_용도}(굵은글씨)**로 해당되고, 연면적이 ${GPT_근거.가목_연면적}㎡이기 때문에 다중이용건축물에 해당됩니다."
    * **해당 없을 시 형식:** "이 건물은 다중이용건축물 기준(가목, 나목)에 해당되지 않습니다."
`;

    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.0, // 안정화
        max_tokens: 300, // 최대 토큰 제한
    });
    let content = response.choices[0].message.content.trim();

    // 🚨🚨🚨 JSON 강제 추출 로직 추가 🚨🚨🚨 (LLM 안정화 V2.8.2 반영)
    const startIndex = content.indexOf('{');
    const endIndex = content.lastIndexOf('}');
    let cleanContent = content;

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        cleanContent = content.substring(startIndex, endIndex + 1);
    } else {
        // 🚨 JSON 구조를 찾지 못한 경우, 원문 텍스트를 판단 근거로 사용
        return {
            다중이용건축물: ruleResult.GPT_근거.결과,
            판단근거: content 
        };
    }

    try {
        return JSON.parse(cleanContent);
    } catch (e) {
        // 🚨 파싱 실패 시에도, 원문 텍스트를 판단 근거로 사용
        return {
            다중이용건축물: ruleResult.GPT_근거.결과,
            판단근거: content
        };
    }
}

// 8.2 LLM 판단 (승강기 결과 기반, 면책 문구 포함) 🆕
async function llmElevatorJudgment(summary) {
    const { isMultiUse, maxFloor } = summary;
    const resultText = isMultiUse ? "예" : "아니오";

    const prompt = `
주어진 정보는 건축물대장 대신 승강기 관리 시스템에서 추출한 데이터로, 건물의 다중이용건축물 여부를 판단한 결과입니다.
당신은 이 정보를 기반으로 정해진 형식의 면책 문구를 포함한 문장을 생성해야 합니다.

**[승강기 데이터 판단 요약]**
- 최종 판단: ${resultText}
- 최고 층수: ${maxFloor}층

**[판단 근거 작성 규칙]**
1.  '다중이용건축물' 키 값은 **${resultText}** 값을 그대로 사용한다.
2.  판단 근거는 다음 형식 중 하나만을 사용하여 구성한다.
    * **해당될 경우:** "이 건물은 승강기정보에 최고 지상층수가 ${maxFloor}층으로 16층 이상에 해당되어 다중이용건축물로 판단됩니다. 하지만 건축물대장이 조회되지 않아 정확한 판단은 어렵습니다."
    * **해당되지 않을 경우:** "이 건물은 승강기정보에 최고 지상층수가 ${maxFloor}층으로 16층 이상에 해당되지 않아 다중이용건축물로 판단되지 않습니다. 하지만 건축물대장이 조회되지 않아 정확한 판단은 어렵습니다."
`;

    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.0, // 안정화
        max_tokens: 300, // 최대 토큰 제한
    });
    let content = response.choices[0].message.content.trim();

    // 🚨🚨🚨 JSON 강제 추출 로직 추가 🚨🚨🚨 (LLM 안정화 V2.8.2 반영)
    const startIndex = content.indexOf('{');
    const endIndex = content.lastIndexOf('}');
    let cleanContent = content;

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        cleanContent = content.substring(startIndex, endIndex + 1);
    } else {
        // 🚨 JSON 구조를 찾지 못한 경우, 원문 텍스트를 그대로 판단 근거로 사용
        return {
            다중이용건축물: resultText,
            판단근거: content 
        };
    }

    try {
        return JSON.parse(cleanContent);
    } catch (e) {
        // 🚨 파싱 실패 시에도, 원문 텍스트를 판단 근거로 사용
        return {
            다중이용건축물: resultText,
            판단근거: content
        };
    }
}

// 9. 웹 클라이언트용 통합 분석 API (최종 Hybrid Flow)
async function apiSummaryHandler(req, res) {
    try {
        // GET 쿼리 또는 POST 바디에서 주소 추출
        const addr = req.query.addr || req.body.addr;
        const cleanAddr = (addr || '').trim();
        
        if (!cleanAddr) {
            return res.status(400).json({ error: "주소가 필요합니다." });
        }

        // 🚨 유효성 필터링 강화
        if (cleanAddr.length < 2 || cleanAddr.includes('{') || cleanAddr.includes('}')) {
            return res.status(400).json({ 
                error: "주소 형식이 올바르지 않습니다. 정확한 주소를 입력해 주세요." 
            });
        }

        // 1. 필수 정보 조회 (Juso)
        const addressInfo = await searchAddress(cleanAddr);
        
        if (!addressInfo) {
            return res.status(404).json({
                error: `"${cleanAddr}"에 대한 주소 검색 결과를 찾을 수 없습니다.`
            });
        }
        
        // 2. 건축물대장 조회 (주변 지번까지 포함하여 조회)
        const items = await fetchBuildingRegister(addressInfo);
        
        // 3. 필터링 및 요약
        const summary = buildSummary(items); 
        
        // 🚨 CRITICAL CHECK: 실질적 Zero Data 감지
        const summaryIsZero = (summary.최고지상층수 === 0) && (summary.가목_연면적_합계 === 0);

        // 🚨 CASE 1: MOLIT Success (Data Found)
        if (summary.총건물수 > 0 && !summaryIsZero) {
            console.log(`[MAIN-PATH] 건축물대장 정보 ${summary.총건물수}건 확인.`);
            
            const ruleResult = isMultiUseBuilding(summary);
            const llmResult = await llmJudgment(ruleResult);
            
            return res.json({
                status: "ok",
                addressInfo: {
                    roadAddr: addressInfo.roadAddr,
                    jibun: addressInfo.jibun
                },
                analysis: {
                    ruleBased: ruleResult.다중이용건축물 ? 'YES' : 'NO',
                    llmFinalDecision: llmResult.다중이용건축물,
                    llmReason: llmResult.판단근거
                },
                summaryDetails: summary, 
                ruleDetails: ruleResult
            });
        } 
        
        // 🚨 CASE 2: MOLIT Failure (No data found or Data is Garbage) -> FALLBACK to Elevator API
        
        console.warn(`[FALLBACK-PATH] 건축물대장 조회 실패/필터링됨. 승강기 API로 최종 검증 시도.`);
        
        // 2-1. 승강기 정보 파편화 조회 함수로 대체
        const elevatorResult = await searchElevatorWithFallbackNames(addressInfo);
        
        // 2-2. 🚨 Elevator Data Found -> Custom Judgment
        if (elevatorResult.count > 0) {
            const bestElevatorItem = findBestMatchingElevator(addressInfo.buldNm, elevatorResult.items);
            
            // 승강기 정보는 찾았으나, 매칭되는 건물명 없음 -> 최종 실패로 처리
            if (!bestElevatorItem) {
                 return res.status(404).json({
                    error: "승강기 정보 조회 성공 후, 건물명 일치 여부를 확인할 수 없습니다.",
                    detail: `총 ${elevatorResult.count}건의 승강기 정보가 있으나, '${addressInfo.buldNm}'와 일치하는 건물을 찾을 수 없습니다. (데이터 불일치 가능성)`
                });
            }

            const elevatorSummary = getElevatorSummary([bestElevatorItem]); // 단일 항목으로 요약
            const llmResult = await llmElevatorJudgment(elevatorSummary);
            
            // Custom Success Response with Disclaimer
            return res.status(200).json({
                status: "ok_fallback",
                addressInfo: {
                    roadAddr: addressInfo.roadAddr,
                    jibun: addressInfo.jibun
                },
                analysis: {
                    llmFinalDecision: llmResult.다중이용건축물,
                    llmReason: llmResult.판단근거
                },
                summaryDetails: {
                    isFallback: true,
                    elevatorCount: elevatorResult.count,
                    elevatorMaxFloor: elevatorSummary.maxFloor
                },
            });
        }
        
        // 2-3. 🚨 Final Failure
        const isZeroJibeon = addressInfo.bun === '0000' && addressInfo.ji === '0000';
        return res.status(404).json({
            error: "건축물대장 및 승강기 등록 정보를 찾을 수 없습니다.",
            detail: isZeroJibeon 
                ? "해당 주소는 지번이 '0번지'이며, 승강기 등록 정보도 없어 건물 존재 여부를 확인할 수 없습니다."
                : "주변 지번까지 확장하여 조회했으나, 유효한 건축물대장 정보와 승강기 등록 정보가 모두 없습니다."
        });


    } catch (err) {
        console.error("FATAL ERROR IN API SUMMARY HANDLER:", err);
        // 클라이언트에게 오류 메시지 전달
        res.status(500).json({ error: "서버에서 조회 실패", detail: String(err) });
    }
}


// 10. (레거시 /summary API는 삭제됨)

// GET/POST 모두 단일 핸들러로 연결 (새로운 웹 API)
app.get("/api/summary", apiSummaryHandler);
app.post("/api/summary", apiSummaryHandler);

// 루트
app.get("/", (req, res) =>
    res.sendFile(path.join(__dirname, "public/index.html"))
);

// 서버 시작
app.listen(PORT, () =>
    console.log(`서버 실행 중 ▶ http://localhost:${PORT}`)
);


