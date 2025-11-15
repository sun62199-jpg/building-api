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

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY) {
  console.warn(
    "⚠️ 환경변수가 부족합니다. JUSO_KEY, MOLIT_KEY, OPENAI_KEY 필요"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 4. JUSO 주소 검색
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
  if (!juso) throw new Error("검색 결과가 없습니다.");

  const admCd = juso.admCd;
  return {
    sigunguCd: admCd.substring(0, 5),
    bjdongCd: admCd.substring(5, 10),
    bun: String(juso.lnbrMnnm || "").padStart(4, "0"),
    ji: String(juso.lnbrSlno || "").padStart(4, "0"),
    jibun: `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`,
    roadAddr: juso.roadAddr,
    rawJuso: juso,
  };
}

// 5. 건축물대장 조회
async function fetchBuildingRegister(addressInfo) {
  const { sigunguCd, bjdongCd, bun, ji } = addressInfo;
  const url = new URL(
    "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo"
  );
  const params = {
    serviceKey: MOLIT_KEY,
    sigunguCd,
    bjdongCd,
    platGbCd: "0",
    bun,
    ji,
    numOfRows: "100",
    pageNo: "1",
    _type: "json",
  };
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
  if (!header || header.resultCode !== "00")
    throw new Error(
      `건축물대장 조회 실패: ${header?.resultMsg || "알 수 없는 오류"}`
    );

  return data.response?.body?.items?.item || [];
}

// 6. 한글화 & 요약
function buildSummary(items) {
  const 다중이용건물 = items.filter(
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

  return {
    총건물수: items.length,
    다중이용건물수: 다중이용건물.length,
    다중이용건물: 다중이용건물.map((it) => ({
      동: it.dongNm,
      용도: it.mainPurpsCdNm,
      연면적: Number(it.totArea),
      지상층: Number(it.grndFlrCnt),
      지하층: Number(it.ugrndFlrCnt),
    })),
  };
}

// 7. 룰 기반 판단
function isMultiUseBuilding(summary) {
  const multiUseAreaThreshold = 5000;
  const 가목대상 = summary.다중이용건물.filter(
    (it) =>
      [
        "문화 및 집회시설",
        "종교시설",
        "판매시설",
        "운수시설",
        "의료시설",
        "숙박시설",
      ].includes(it.용도) && it.연면적 >= multiUseAreaThreshold
  );
  const 나목대상 = summary.다중이용건물.filter(
    (it) =>
      ![
        "문화 및 집회시설",
        "종교시설",
        "판매시설",
        "운수시설",
        "의료시설",
        "숙박시설",
      ].includes(it.용도) && it.지상층 >= 16
  );

  const 결과 = 가목대상.length > 0 || 나목대상.length > 0;
  return {
    다중이용건축물: 결과,
    판단이유: 결과
      ? `가목: ${가목대상.length}개, 나목: ${나목대상.length}개`
      : "가목·나목 해당 없음",
  };
}

// 8. LLM 판단
async function llmJudgment(summary) {
  const prompt = `
다음 건축물 정보를 바탕으로 이 건물이 다중이용건축물인지 판단하고, 판단 근거를 JSON 형태로 알려줘.
${JSON.stringify(summary, null, 2)}

출력 예시:
{ "다중이용건축물": "예/아니오", "판단근거": "설명" }
`;
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });
  const content = response.choices[0].message.content;
  return JSON.parse(content);
}

// --- 9. 카카오톡 스킬 핸들러 (2단계 분리) ---

// 9.1. 1단계: 룰 기반만 빠르게 응답하는 핸들러
async function kakaoRuleHandler(req, res) {
  try {
    let addr;
    
    // 주소 추출 로직
    if (req.method === "GET") {
      addr = req.query.addr;
    } else if (req.method === "POST") {
      if (req.body && req.body.action && req.body.action.params) {
        addr = req.body.action.params.addr; 
      }
      if (!addr && req.body.addr) {
        addr = req.body.addr;
      }
    }

    if (!addr) {
      return res.status(400).json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: "주소가 필요합니다. 다시 입력해 주세요." } }],
        },
      });
    }

    // 1단계 처리: JUSO, MOLIT, Rule 판단 (5초 이내 완료)
    const addressInfo = await searchAddress(addr);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const ruleResult = isMultiUseBuilding(summary);
    
    // LLM 분석에 필요한 summary 데이터를 Base64로 인코딩하여 버튼에 담기
    const encodedSummary = Buffer.from(JSON.stringify(summary)).toString('base64');

    // 1단계 카카오 스킬용 JSON (룰 기반 결과 + LLM 호출 버튼)
    const responseJSON = {
      version: "2.0",
      template: {
        outputs: [
          {
            simpleText: {
              text: `📍 주소: ${addressInfo.roadAddr}\n` +
                    `✅ 룰 기반 판단: ${ruleResult.다중이용건축물 ? "예" : "아니오"} (${ruleResult.판단이유})\n\n` +
                     `🧠 AI 분석 결과를 요청해 주세요.`
            }
          }
        ],
         // 퀵 리플라이 버튼을 추가하여 LLM 분석을 2단계로 분리
         quickReplies: [ 
             {
                 label: "🧠 AI 분석 결과 보기",
                 action: "message", 
                 // 2단계 처리를 담당하는 라우트를 호출하도록 메시지 텍스트를 설정해야 합니다.
                 // 이 예시에서는 챗봇 빌더에서 메시지 텍스트를 '/kakao-llm-analysis' 라우트로 연결해야 합니다.
                 messageText: "AI 분석 결과 요청",
                 extra: { 
                     summary: encodedSummary,
                     type: "LLM_REQUEST" // 2단계 요청임을 알리는 플래그
                 }
             }
         ]
      }
    };

    res.json(responseJSON);

  } catch (err) {
    console.error("FATAL ERROR IN KAKAO RULE HANDLER (1단계):", err);
    res.status(500).json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: `조회 실패 (1단계): ${String(err)}` } }
        ]
      }
    });
  }
}


// 9.2. 2단계: LLM 판단만 하는 핸들러 (기존 kakaoSummaryHandler의 역할 대체)
async function kakaoLlmHandler(req, res) {
  try {
    // 1단계 버튼에서 인코딩된 summary 데이터가 넘어왔는지 확인
    const encodedSummary = req.body?.action?.extra?.summary;
    const requestType = req.body?.action?.extra?.type;

    if (!encodedSummary || requestType !== "LLM_REQUEST") {
        // 비정상적이거나 1단계 요청이 아닐 경우 오류 처리
        return res.status(400).json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: "AI 분석 데이터가 유효하지 않습니다. 다시 주소를 입력해주세요." } }],
            },
        });
    }

    // 2단계 요청 (LLM 분석)
    const decodedSummary = Buffer.from(encodedSummary, 'base64').toString('utf8');
    const summary = JSON.parse(decodedSummary);
    
    // LLM 판단 실행 (가장 오래 걸리는 작업)
    const llmResult = await llmJudgment(summary);

    // 2단계 카카오 스킬용 JSON (LLM 결과만 포함)
    const responseJSON = {
      version: "2.0",
      template: {
        outputs: [{
          simpleText: {
            text: `🧠 AI 분석 결과입니다.\n\n` +
                  `LLM 판단: ${llmResult.다중이용건축물} (${llmResult.판단근거})`
          }
        }]
      }
    };

    res.json(responseJSON);

  } catch (err) {
    console.error("FATAL ERROR IN KAKAO LLM HANDLER (2단계):", err);
    res.status(500).json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: `조회 실패 (2단계): ${String(err)}` } }
        ]
      }
    });
  }
}


// --- 10. 기존 summary 라우트 유지 (변경 없음) ---
app.get("/summary", async (req, res) => {
  try {
    const addr = req.query.addr;
    if (!addr) return res.status(400).json({ error: "주소 필요" });
    const addressInfo = await searchAddress(addr);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const multiUse = isMultiUseBuilding(summary);

    const 최고지상층수 = summary.다중이용건물.length
      ? Math.max(...summary.다중이용건물.map((it) => it.지상층 || 0))
      : 0;

    const GA_TYPES = [
      "문화 및 집회시설",
      "종교시설",
      "판매시설",
      "운수시설",
      "의료시설",
      "숙박시설",
    ];
    const 가항목 = {};
    GA_TYPES.forEach((type) => {
      const 대상 = summary.다중이용건물.filter(
        (it) => it.용도 === type && it.연면적 >= 5000
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

// --- 11. 라우트 연결 (2단계 분리 적용) ---

// 1단계: 주소 입력 시 호출되는 라우트 (룰 기반 판단 및 버튼 응답)
app.get("/kakao-summary", kakaoRuleHandler);
app.post("/kakao-summary", kakaoRuleHandler);

// 2단계: AI 분석 버튼 클릭 시 호출되는 라우트 (LLM 판단 응답)
app.post("/kakao-llm-analysis", kakaoLlmHandler); 


// 루트
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

// 서버 시작
app.listen(PORT, () =>
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`)
);
