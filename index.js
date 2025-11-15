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

if (!JUSO_KEY || !MOLIT_KEY) {
  console.warn("⚠️ JUSO_KEY 또는 MOLIT_KEY 환경변수가 설정되지 않았습니다.");
}

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // public/index.html

// ------------------------------------------------------------
// 4. JUSO 주소 검색
// ------------------------------------------------------------
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

  console.log("📡 JUSO API 요청:", url.toString());
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
    roadAddr: juso.roadAddr,
    rawJuso: juso,
  };
}

// ------------------------------------------------------------
// 5. 건축물대장 조회
// ------------------------------------------------------------
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

  console.log("📡 건축물대장 API 요청:", url.toString());
  const res = await fetch(url.toString());
  const text = await res.text();
  console.log("📦 건축물대장 RAW 응답 앞부분:", text.slice(0, 200));
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

// ------------------------------------------------------------
// 6. 요약 데이터 생성 (필요 항목만 정리)
// ------------------------------------------------------------
function buildSummary(items) {
  return items.map(it => ({
    용도: it.mainPurpsCdNm,
    연면적: Number(it.totArea),
    지상층: Number(it.grndFlrCnt),
    기타용도: it.etcPurps
  }));
}

// ------------------------------------------------------------
// 7. 다중이용건축물 판단 (가·나 항목별 상세판단)
// ------------------------------------------------------------
function evaluateMultiUse(summary) {
  
  const GA_TYPES = [
    "문화 및 집회시설",
    "종교시설",
    "판매시설",
    "운수시설",
    "의료시설",
    "숙박시설"
  ];

  // 가 항목 판단: 연면적 5000 이상?
  const gaResult = {};
  GA_TYPES.forEach(type => {
    const 대상 = summary.filter(it => it.용도 === type && it.연면적 >= 5000);
    gaResult[type] = 대상.length > 0 ? "해당" : "해당없음";
  });

  // 나 항목: 최고 지상층수
  const highestFloor = Math.max(...summary.map(it => it.지상층 || 0));

  const isMulti = 
    Object.values(gaResult).includes("해당") ||
    highestFloor >= 16;

  return {
    다중이용건축물: isMulti ? "예" : "아니오",
    가항목: gaResult,
    나항목: { 최고지상층수: highestFloor }
  };
}

// ------------------------------------------------------------
// 8. /summary API
// ------------------------------------------------------------
app.get("/summary", async (req, res) => {
  try {
    const input = req.query.addr;
    if (!input) return res.status(400).json({ error: "주소 필요" });

    const addressInfo = await searchAddress(input);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const decision = evaluateMultiUse(summary);

    res.json({
      주소: addressInfo.roadAddr,
      다중이용건축물: decision.다중이용건축물,
      판단근거: {
        가: decision.가항목,
        나: decision.나항목
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "조회 실패", detail: String(err) });
  }
});

// ------------------------------------------------------------
// 루트 페이지
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ------------------------------------------------------------
// 서버 시작
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`);
});
