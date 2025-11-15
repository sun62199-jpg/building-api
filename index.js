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

**[최우선 적용 규칙]**
1.  **가목 제외 용도 (공동주택, 근린생활시설 등)**: 이 건물들은 연면적과 관계없이, **지상층이 16층 이상인 경우 무조건 나목 기준에 해당**되어 다중이용건축물이다.
2.  **가목 기준 용도**: 문화/판매/숙박/의료/종교/운수 시설만 해당되며, 연면적이 5000㎡ 이상일 때 다중이용건축물이다.
3.  **판단 근거**는 아래 형식 중 하나만을 사용하여 단정적인 문장 하나로 구성되어야 한다:

    * **나목 해당 시 형식 (16층 이상):** "이 건물은 **[데이터 내 최고 지상층 수치]층** 이상이므로 나목 기준에 해당되어 다중이용건축물에 해당됩니다."
    * **가목 해당 시 형식:** "이 건물은 다중이용건축물 기준 중 **[해당되는 가목 용도](굵은글씨)**로 해당되고, 연면적이 **[총 연면적 수치]㎡**이기 때문에 다중이용건축물에 해당됩니다."
    * **해당 없을 시 형식:** "이 건물은 다중이용건축물 기준(가목, 나목)에 해당되지 않습니다."

**[건축물 정보]**
${JSON.stringify(summary, null, 2)}

출력 예시 (나목):
{ "다중이용건축물": "예", "판단근거": "이 건물은 29층 이므로 다중이용건축물에 해당됩니다." }

출력 예시 (가목):
{ "다중이용건축물": "예", "판단근거": "이 건물은 다중이용건축물 기준 중 **판매시설**로 해당되고, 연면적이 6000㎡이기 때문에 다중이용건축물에 해당됩니다." }
`;
    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
    });
    const content = response.choices[0].message.content;
    return JSON.parse(content);
}

// 9. 카카오톡 스킬용 라우트 (룰 + LLM) - 단일 응답 구조로 최종 복원
async function kakaoSummaryHandler(req, res) {
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
    
    // 🚨 유효성 필터링 강화 (변수 전달 오류로 플레이스홀더 등이 넘어오는 경우 방지)
    const cleanAddr = (addr || '').trim(); 
    if (cleanAddr.length < 2 || cleanAddr.includes('{') || cleanAddr.includes('}')) {
        console.error(`[INVALID ADDR] 유효하지 않은 주소 형식 감지: ${addr}`);
        return res.status(400).json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: "주소 형식이 올바르지 않습니다. 정확한 주소를 입력해 주세요." } }],
            },
        });
    }

    // 1. 필수 정보 조회 (Juso, Molit)
    const addressInfo = await searchAddress(cleanAddr); 
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);

    // 2. 룰 기반 판단 (빠름)
    const ruleResult = isMultiUseBuilding(summary);
    
    // 3. LLM 판단 호출 (가장 오래 걸리는 작업, 여기서 대기)
    const llmResult = await llmJudgment(summary);
    
    // 4. 🎨 응답 텍스트 구성: 마크다운 및 이모지 적용으로 가독성 개선
    const responseText = 
        `🏢 **[다중이용 건축물 조회 결과]**\n` +
        `----------------------------------------\n` +
        `📍 **주소:** ${addressInfo.roadAddr} (${addressInfo.jibun})\n\n` +
        
        `📊 **규칙 기반 즉시 판단**\n` +
        `----------------------------------------\n` +
        `다중이용건축물 여부: **${ruleResult.다중이용건축물 ? '⚠️ 예' : '✅ 아니오'}**\n` +
        `판단 근거: ${ruleResult.판단이유}\n\n` +
        
        `🧠 **AI 상세 분석 (GPT)**\n` +
        `----------------------------------------\n` +
        `AI 판단: **${llmResult.다중이용건축물}**\n` +
        `분석 근거: ${llmResult.판단근거}`;


    // 카카오 스킬용 JSON
    const responseJSON = {
      version: "2.0",
      template: {
        outputs: [
          {
            simpleText: {
              text: responseText
            }
          }
        ]
      }
    };

    res.json(responseJSON);

  } catch (err) {
    console.error("FATAL ERROR IN KAKAO SUMMARY HANDLER (단일 응답):", err);
    res.status(500).json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: `조회 실패: ${String(err)}` } }
        ]
      }
    });
  }
}


// 10. 기존 summary 유지
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

// GET/POST 모두 단일 핸들러로 연결
app.get("/kakao-summary", kakaoSummaryHandler);
app.post("/kakao-summary", kakaoSummaryHandler);

// 루트
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

// 서버 시작
app.listen(PORT, () =>
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`)
);





