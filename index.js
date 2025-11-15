// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3(CommonJS에서 ESM 사용)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 환경변수 확인
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY; // OpenAI Key 추가

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY) {
  console.warn("⚠️ JUSO_KEY, MOLIT_KEY 또는 OPENAI_KEY가 설정되지 않았습니다.");
}

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // public/index.html

// 4. JUSO 주소 검색
async function searchAddress(input) {
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
  const url = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo");
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
  if (!header || header.resultCode !== "00") {
    throw new Error(`건축물대장 조회 실패: ${header?.resultMsg || "알 수 없는 오류"}`);
  }

  const items = data.response?.body?.items?.item || [];
  if (items.length === 0) throw new Error("건축물대장 조회 결과가 없습니다.");
  return items;
}

// 6. 한글화 & 요약
function buildSummary(items) {
  const 다중이용건물 = items.filter(it =>
    [
      "공동주택",
      "제2종근린생활시설",
      "문화 및 집회시설",
      "종교시설",
      "판매시설",
      "운수시설",
      "의료시설",
      "숙박시설",
    ].includes(it.mainPurpsCdNm) || (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
  );

  const totalArea = 다중이용건물.reduce((sum, it) => sum + (Number(it.totArea) || 0), 0);

  return {
    총건물수: items.length,
    다중이용건물수: 다중이용건물.length,
    총연면적: totalArea,
    다중이용건물: 다중이용건물.map(it => ({
      동: it.dongNm,
      건축물구분: it.mainAtchGbCdNm,
      용도: it.mainPurpsCdNm,
      기타용도: it.etcPurps,
      연면적: Number(it.totArea),
      지상층: Number(it.grndFlrCnt),
      지하층: Number(it.ugrndFlrCnt),
      지붕: it.roofCdNm,
      구조: it.strctCdNm,
      사용승인일: it.useAprDay,
      비상용승강기: Number(it.emgenUseElvtCnt),
      승용승강기: Number(it.rideUseElvtCnt),
    }))
  };
}

// 7. 다중이용건축물 판단
function isMultiUseBuilding(summary) {
  const multiUseAreaThreshold = 5000;

  const 가목대상 = summary.다중이용건물
    .filter(it =>
      ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"]
        .some(u => it.용도.includes(u)) && it.연면적 >= multiUseAreaThreshold
    );

  const 나목대상 = summary.다중이용건물
    .filter(it =>
      !["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"]
        .some(u => it.용도.includes(u)) && it.지상층 >= 16
    );

  const 결과 = 가목대상.length > 0 || 나목대상.length > 0;

  return {
    다중이용건축물: 결과,
    판단이유: 결과
      ? `가목: ${가목대상.length}개, 나목: ${나목대상.length}개`
      : "가목·나목 해당 없음",
  };
}

// 8. /summary API
app.get("/summary", async (req, res) => {
  try {
    const input = req.query.addr;
    if (!input) return res.status(400).json({ error: "주소 필요" });

    const addressInfo = await searchAddress(input);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const multiUse = isMultiUseBuilding(summary);

    const 최고지상층수 = summary.다중이용건물.length
      ? Math.max(...summary.다중이용건물.map(it => it.지상층 || 0))
      : 0;

    const GA_TYPES = [
      "문화 및 집회시설",
      "종교시설",
      "판매시설",
      "운수시설",
      "의료시설",
      "숙박시설"
    ];

    const 가항목 = {};
    GA_TYPES.forEach(type => {
      const 대상 = summary.다중이용건물.filter(it =>
        it.용도 === type && it.연면적 >= 5000
      );
      가항목[type] = 대상.length > 0 ? "해당" : "해당없음";
    });

    res.json({
      주소: `${addressInfo.roadAddr} (${addressInfo.jibun})`,
      다중이용건축물: multiUse.다중이용건축물 ? "예" : "아니오",
      판단근거: {
        가: 가항목,
        나: { 최고지상층수 }
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "조회 실패", detail: String(err) });
  }
});

// 9. /kakao 웹훅
app.post("/kakao", async (req, res) => {
  try {
    const userText = req.body.userRequest?.utterance;
    if (!userText) return res.status(400).json({ error: "메시지 내용이 없습니다." });

    const [addr, question] = userText.split("|").map(s => s.trim());
    const addressInfo = await searchAddress(addr);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);

    // OpenAI LLM 호출
    const llmRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "당신은 한국 다중이용건축물 판단 전문 어시스턴트입니다." },
          { role: "user", content: `주소: ${addr}\n건물 정보: ${JSON.stringify(summary)}\n질문: ${question}` }
        ],
        temperature: 0.2
      })
    });

    const data = await llmRes.json();
    const answer = data.choices?.[0]?.message?.content || "답변을 가져올 수 없습니다.";

    res.json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: answer } }]
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: `오류 발생: ${err.message}` } }] }
    });
  }
});

// 루트
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`);
});
