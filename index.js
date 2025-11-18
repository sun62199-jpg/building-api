// 1. 기본 세팅_test v.3 251118 20시58분
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
    siNm: juso.siNm, // 시/도 이름
    sggNm: juso.sggNm, // 시/군/구 이름
    buldNm: juso.bdNm, // 건물 이름
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

// 5.2 🆕 승강기 정보 조회 함수 (보조 데이터 획득)
async function fetchElevatorInfo(siNm, sggNm, buldNm) {
    if (!buldNm || !siNm) {
        return { count: 0, items: [] };
    }
    
    // 승강기 API는 시/도 이름, 시/군/구 이름, 건물명으로 조회
    const params = {
        serviceKey: ELEVATOR_KEY, 
        pageNo: "1",
        numOfRows: "100",
        sido: siNm, 
        sigungu: sggNm, 
        buld_nm: buldNm,
        _type: "json",
    };

    const url = new URL(
        `https://apis.data.go.kr/1613000/ElevatorListService/getElevatorListM`
    );

    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        
        if (data.response?.header?.resultCode !== "00") {
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
        // 네트워크 오류 등 발생 시 콘솔에 로그만 남기고 빈 데이터 반환
        console.error(`[ELEVATOR-ERROR] API 호출 중 오류 발생: ${error.message}`);
        return { count: 0, items: [] };
    }
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
        // 🚨 데이터가 발견되면 병합하고 즉시 루프 종료
        return allItems;
      }
    } catch (error) {
      throw new Error(`주변 지번 조회 중 치명적 오류: ${error.message}`);
    }
  }

  // 모든 주변 지번 조회 실패 시
  return allItems;
}


// 6. 한글화 & 요약 (Node.js 계산 및 내부 필터링)
function buildSummary(items) {
    const CURRENT_YEAR = new Date().getFullYear();
    
    // 🚨 최종 필터링 로직 (불량 데이터 및 엉뚱한 용도 제거) 🚨
    const filteredItems = items.filter(it => {
        const purpName = it.mainPurpsCdNm?.trim() || ''; 
        const purpCode = it.mainPurpsCd?.trim() || ''; 
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;
        const useAprYear = Number(it.useAprDay?.substring(0, 4)) || 0;
        
        // --- 1. 불완전 데이터 필터링 ---
        if (totArea === 0 || purpCode === '') {
            if (grndFlrCnt >= 16) return true; 
            return false;
        }

        // --- 2. 엉뚱한 용도 필터링 ---
        const isFactoryOrWarehouseCode = purpCode === '17000' || purpCode === '21000';
        const isFactoryOrWarehouseName = purpName.includes('공장') || purpName.includes('창고') || purpName.includes('위험물');

        if (isFactoryOrWarehouseCode || isFactoryOrWarehouseName) {
            return false;
        }
        
        // --- 3. 노후도 필터링 ---
        if (useAprYear > 0 && (CURRENT_YEAR - useAprYear) > 40 && grndFlrCnt < 5) {
            return false; 
        }
        
        return true;
    });
    
    // 필터링된 목록을 바탕으로 다중이용건축물 필터링 및 요약
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
        
    // 1. 최고층 수치 계산
    const 최고지상층수 = 다중이용건물.length 
        ? Math.max(...다중이용건물.map(it => Number(it.grndFlrCnt) || 0)) 
        : 0;

    // 2. 가목 해당 용도의 연면적 합계 계산
    const 가목_연면적_합계 = 다중이용건물
        .filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm))
        .reduce((sum, item) => sum + Number(item.totArea), 0);
    
    // 3. 가목 해당 용도 (문장 생성을 위한 대표 용도 1개)
    const 가목_용도 = 다중이용건물.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));
    
    return {
        총건물수: filteredItems.length,
        다중이용건물수: 다중이용건물.length,
        최고지상층수: 최고지상층수,
        가목_연면적_합계: 가목_연면적_합계, 
        가목_대표_용도: 가목_용도 ? 가목_용도.mainPurpsCdNm : null, // 대표 용도 문자열
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
    
    // 1. 나목 해당 여부 (가목 용도 외 모든 건물 16층 이상)
    const 나목_해당 = 최고지상층수 >= 16;
    
    // 2. 가목 해당 여부
    const 가목_해당 = 가목_합계 >= multiUseAreaThreshold;
    
    // GPT가 문장을 만들도록 최종 근거 데이터 생성
    let GPT_판단_근거 = {};

    if (가목_해당) {
        // 가목 해당 시 나목 무시 (가목이 더 엄격한 기준)
        GPT_판단_근거 = {
            결과: "예",
            판단_기준: "가목",
            가목_용도: summary.가목_대표_용도,
            가목_연면적: 가목_합계.toFixed(2)
        };
    } else if (나목_해당) {
        // 나목 해당 시 (가목에 해당하지 않으므로)
        GPT_판단_근거 = {
            결과: "예",
            판단_기준: "나목",
            최고층: 최고지상층수
        };
    } else {
        // 둘 다 해당 없음
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
        // 🚨 GPT가 문장만 생성하도록 최종 판단 근거 데이터 전달
        GPT_근거: GPT_판단_근거
    };
}

// 8. LLM 판단 (계산된 결과로 문장만 생성하는 역할로 축소)
async function llmJudgment(ruleResult) { // ruleResult 객체를 인수로 받음
    const { GPT_근거 } = ruleResult;
    
    const prompt = `
주어진 JSON 데이터는 건축물의 다중이용건축물 여부를 서버가 최종 판단한 결과입니다.
당신의 역할은 이 결과를 바탕으로 정해진 형식의 '판단근거' 문장을 생성하는 것입니다.
계산을 수행하지 말고, 오직 주어진 GPT_근거 데이터만을 사용하여 문장을 생성해야 합니다.

**[GPT_근거 데이터]**
${JSON.stringify(GPT_근거, null, 2)}

**[판단 근거 작성 규칙]**
1.  '다중이용건축물' 키 값은 **GPT_근거.결과** 값을 그대로 사용한다.
2.  판단 근거는 아래 형식 중 **하나만을 사용**하여 단정적인 문장 하나로 구성한다.

    * **나목 해당 시 형식:** "이 건물은 ${GPT_근거.최고층}층 이므로 다중이용건축물에 해당됩니다."
    * **가목 해당 시 형식:** "이 건물은 다중이용건축물 기준 중 **${GPT_근거.가목_용도}(굵은글씨)**로 해당되고, 연면적이 ${GPT_근거.가목_연면적}㎡이기 때문에 다중이용건축물에 해당됩니다."
    * **해당 없을 시 형식:** "이 건물은 다중이용건축물 기준(가목, 나목)에 해당되지 않습니다."

출력 예시:
{ "다중이용건축물": "예", "판단근거": "이 건물은 29층 이므로 다중이용건축물에 해당됩니다." }
`;

    // 🚨 LLM 호출 
    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1, 
    });
    const content = response.choices[0].message.content;

    try {
        return JSON.parse(content);
    } catch (e) {
        console.error("LLM JSON 파싱 오류:", content);
        return {
            다중이용건축물: ruleResult.GPT_근거.결과,
            판단근거: `AI 응답 형식 오류. 서버의 ${ruleResult.GPT_근거.결과} 판단을 따름.`
        };
    }
}

// 9. 웹 클라이언트용 통합 분석 API (카카오톡 라우터 대체)
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
            console.error(`[INVALID ADDR] 유효하지 않은 주소 형식 감지: ${addr}`);
            return res.status(400).json({ 
                error: "주소 형식이 올바르지 않습니다. 정확한 주소를 입력해 주세요." 
            });
        }

        // 1. 필수 정보 조회 (Juso)
        const addressInfo = await searchAddress(cleanAddr);
        
        // 🚨 주소 검색 결과가 null인 경우 (없는 주소인 경우) 처리
        if (!addressInfo) {
            return res.status(404).json({
                error: `"${cleanAddr}"에 대한 주소 검색 결과를 찾을 수 없습니다.`
            });
        }
        
        // 🚨 0번지 필터링 로직 (조회 자체가 무의미한 경우 차단)
        if (addressInfo.bun === '0000' && addressInfo.ji === '0000') {
            console.warn(`[ZERO_BUN_WARN] 지번이 0번지(예: 덕계동 0)로 감지됨. 최종 검증 시작.`);
            
            // 🚨 0번지 주소일 경우 승강기 API를 최종 검증 수단으로 사용
            const elevatorResult = await fetchElevatorInfo(addressInfo.siNm, addressInfo.sggNm, addressInfo.buldNm);
            
            if (elevatorResult.count > 0) {
                 // 승강기 정보가 발견된 경우 (건물 존재 확인됨)
                 return res.status(404).json({
                     error: "건축물대장 조회가 불가능합니다.",
                     detail: `하지만 승강기 관리 시스템에서 **${addressInfo.buldNm}**의 등록 정보 ${elevatorResult.count}건을 확인했습니다. (지번 불일치 문제)`,
                     elevatorStatus: { count: elevatorResult.count, status: "데이터 존재" }
                 });
            }

            // 승강기 API로도 건물을 찾지 못한 경우에만 404 반환
            return res.status(404).json({
                error: "해당 주소는 지번이 '0번지'이며, 승강기 등록 정보도 없어 건축물대장 조회가 불가능합니다."
            });
        }
        
        // 2. 건축물대장 조회 (주변 지번까지 포함하여 조회)
        const items = await fetchBuildingRegister(addressInfo);
        
        // 3. 필터링 및 요약
        const summary = buildSummary(items); 
        
        // 🚨 필터링 후 유효한 건물이 0개인지 확인
        if (summary.총건물수 === 0) {
            return res.status(404).json({
                error: "조회는 성공했으나, 다중이용건축물 판단에 사용할 수 있는 유효한 건축물 정보가 없습니다."
            });
        }
        
        // 4. 룰 기반 판단
        const ruleResult = isMultiUseBuilding(summary);
        
        // 5. LLM 판단 호출
        const llmResult = await llmJudgment(ruleResult);
        
        // 6. 🖼️ 웹 클라이언트용 JSON 응답 (순수한 데이터 반환)
        res.json({
            status: "ok",
            addressInfo: {
                roadAddr: addressInfo.roadAddr,
                jibun: addressInfo.jibun
            },
            analysis: {
                // 최종적으로 UI에 표시할 핵심 정보
                ruleBased: ruleResult.다중이용건축물 ? 'YES' : 'NO',
                llmFinalDecision: llmResult.다중이용건축물,
                llmReason: llmResult.판단근거
            },
            // 디버깅/추가 표시용 상세 정보
            summaryDetails: summary, 
            ruleDetails: ruleResult
        });

    } catch (err) {
        console.error("FATAL ERROR IN API SUMMARY HANDLER:", err);
        // 클라이언트에게 오류 메시지 전달
        res.status(500).json({ error: "서버에서 조회 실패", detail: String(err) });
    }
}


// 10. 기존 summary 유지 (레거시 API)
app.get("/summary", async (req, res) => {
    try {
        const addr = req.query.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });
        const addressInfo = await searchAddress(addr);
        
        if (!addressInfo) { return res.status(400).json({ error: "주소 검색 결과 없음" }); } 
        
        const items = await fetchBuildingRegister(addressInfo);
        const summary = buildSummary(items);
        const multiUse = isMultiUseBuilding(summary);

        const 최고지상층수 = summary.최고지상층수 || 0; 

        const GA_TYPES = [
            "문화 및 집회시설",
            "종교시설",
            "판매시설",
            "운수시설",
            "의료시설",
            "숙박시설",
        ];
        const 가항목 = {};
        const multiUseAreaThreshold = 5000;
        GA_TYPES.forEach((type) => {
            const 대상 = summary.다중이용건물.filter(
                (it) => it.용도 === type && it.연면적 >= multiUseAreaThreshold
            );
            가항목[type] = 대상.length > 0 ? "해당" : "해당없음";
        });

        res.json({
            주소: `${addressInfo.roadAddr} (${addressInfo.jibun})`,
            다중이용건축물: multiUse.다중이용건축물 ? "예" : "아니오",
            판단근거: { 가: 가항목, 나: { 최고지상층수 } },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "조회 실패", detail: String(err) });
    }
});

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
