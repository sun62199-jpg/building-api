// index.js (CommonJS 버전)

// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// 🔥 node-fetch v3 (ESM 전용)을 CommonJS에서 사용
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 환경변수 확인 (JUSO_KEY / MOLIT_KEY)
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;

if (!JUSO_KEY || !MOLIT_KEY) {
  console.warn("⚠️ JUSO_KEY 또는 MOLIT_KEY 환경변수가 설정되지 않았습니다.");
}

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // public/index.html

// 4. JUSO 주소 검색 함수
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

  const res = await fetch(url.toString(), { method: "GET" });
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
  const sigunguCd = admCd.substring(0, 5);
  const bjdongCd = admCd.substring(5, 10);
  const bun = String(juso.lnbrMnnm || "").padStart(4, "0");
  const ji = String(juso.lnbrSlno || "").padStart(4, "0");

  const addressInfo = {
    sigunguCd,
    bjdongCd,
    bun,
    ji,
    jibun: `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`,
    roadAddr: juso.roadAddr,
    rawJuso: juso,
  };

  console.log("🏠 addressInfo:", addressInfo);
  return addressInfo;
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

  console.log("📡 건축물대장 API 요청:", url.toString());

  const res = await fetch(url.toString(), { method: "GET" });
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

// 6. 한글화 & 요약
function buildSummary(items) {
  const 아파트 = items.filter(
    (it) =>
      it.mainPurpsCdNm === "공동주택" &&
      typeof it.etcPurps === "string" &&
      it.etcPurps.includes("공동주택(아파트)") &&
      it.mainAtchGbCdNm === "주건축물"
  );

  const 상업 = items.filter(
    (it) =>
      it.mainPurpsCdNm === "제2종근린생활시설" ||
      (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
  );

  const 부속 = items.filter(
    (it) =>
      it.mainAtchGbCdNm === "부속건축물" &&
      !(
        it.mainPurpsCdNm === "제2종근린생활시설" ||
        (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
      )
  );

  const totalHousehold = items.reduce((sum, it) => sum + (Number(it.hhldCnt) || 0), 0);

  return {
    총건물수: items.length,
    아파트동수: 아파트.length,
    상업동수: 상업.length,
    부속동수: 부속.length,
    총세대수: totalHousehold,
    상업시설여부: 상업.length > 0,
    아파트동목록: 아파트.map((it) => it.dongNm),
    아파트: 아파트.map((it) => ({
      동: it.dongNm,
      건축물구분: it.mainAtchGbCdNm,
      용도: it.mainPurpsCdNm,
      기타용도: it.etcPurps,
      연면적: Number(it.totArea),
      지상층: Number(it.grndFlrCnt),
      지하층: Number(it.ugrndFlrCnt),
      세대수: Number(it.hhldCnt),
      지붕: it.roofCdNm,
      구조: it.strctCdNm,
      사용승인일: it.useAprDay,
      비상용승강기: Number(it.emgenUseElvtCnt),
      승용승강기: Number(it.rideUseElvtCnt),
    })),
    상업: 상업.map((it) => ({
      동: it.dongNm,
      건축물구분: it.mainAtchGbCdNm,
      용도: it.mainPurpsCdNm,
      기타용도: it.etcPurps,
      연면적: Number(it.totArea),
      지상층: Number(it.grndFlrCnt),
      지하층: Number(it.ugrndFlrCnt),
      세대수: Number(it.hhldCnt),
      지붕: it.roofCdNm,
      구조: it.strctCdNm,
      사용승인일: it.useAprDay,
      비상용승강기: Number(it.emgenUseElvtCnt),
      승용승강기: Number(it.rideUseElvtCnt),
    })),
    부속건물: 부속.map((it) => ({
      동: it.dongNm,
      건축물구분: it.mainAtchGbCdNm,
      용도: it.mainPurpsCdNm,
      기타용도: it.etcPurps,
      연면적: Number(it.totArea),
      지상층: Number(it.grndFlrCnt),
      지하층: Number(it.ugrndFlrCnt),
      세대수: Number(it.hhldCnt),
      지붕: it.roofCdNm,
      구조: it.strctCdNm,
      사용승인일: it.useAprDay,
      비상용승강기: Number(it.emgenUseElvtCnt),
      승용승강기: Number(it.rideUseElvtCnt),
    })),
  };
}

// 7. 다중이용건축물 판단
function isMultiUseBuilding(summary) {
  // 가목: 특정 용도 + 연면적 5천 이상
  const multiUseAreaThreshold = 5000;

  const 가목대상 = summary.아파트.concat(summary.상업).concat(summary.부속건물).filter((it) => {
    const 특정용도 = ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"];
    return 특정용도.some((u) => it.용도.includes(u)) && it.연면적 >= multiUseAreaThreshold;
  });

  // 나목: 16층 이상
  const 나목대상 = summary.아파트.concat(summary.상업).concat(summary.부속건물).filter((it) => it.지상층 >= 16);

  const 결과 = 가목대상.length > 0 || 나목대상.length > 0;

  return {
    다중이용건축물: 결과,
    판단이유: 결과
      ? `가목: ${가목대상.length}개, 나목: ${나목대상.length}개`
      : "가목·나목 해당 없음",
  };
}

// 8. API 라우트
app.get("/llm-summary", async (req, res) => {
  try {
    const input = req.query.addr;
    if (!input) return res.status(400).json({ error: "주소 필요" });

    const addressInfo = await searchAddress(input);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const multiUse = isMultiUseBuilding(summary);

    res.json({
      주소: input,
      요약: summary,
      다중이용건축물판단: multiUse,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "조회 실패", detail: String(err) });
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
