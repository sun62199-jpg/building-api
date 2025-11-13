// index.js
// package.json 에서는 "type": "module" 빼고(CommonJS) 사용

const express = require("express");
require("dotenv").config();

// node-fetch v3 (ESM 전용) CommonJS에서 쓰는 트릭
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`);
});

// 🔑 .env 에 정의된 키 사용
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;

if (!JUSO_KEY || !MOLIT_KEY) {
  console.warn("⚠️ JUSO_KEY 또는 MOLIT_KEY 환경변수가 설정되지 않았습니다.");
}

app.use(express.json());

/**
 * 1. 주소 → 지번/코드 조회 (도로명주소 API)
 */
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
  if (!res.ok) {
    throw new Error(`주소 검색 API 오류: HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data.results || data.results.common.errorCode !== "0") {
    throw new Error(
      `주소 검색 실패: ${
        data.results?.common?.errorMessage || "알 수 없는 오류"
      }`
    );
  }

  const juso = data.results.juso[0];
  if (!juso) {
    throw new Error("검색 결과가 없습니다.");
  }

  // 🔥 여기부터가 핵심 수정 부분
  const admCd = juso.admCd; // 예: 4163011400
  const sigunguCd =
    juso.sigunguCd || (admCd ? admCd.substring(0, 5) : undefined);
  const bjdongCd =
    juso.bjdongCd || (admCd ? admCd.substring(5, 10) : undefined);

  const bun =
    juso.bun ||
    (juso.lnbrMnnm ? String(juso.lnbrMnnm).padStart(4, "0") : undefined);
  const ji =
    juso.ji ||
    (juso.lnbrSlno ? String(juso.lnbrSlno).padStart(4, "0") : "0000");

  if (!sigunguCd || !bjdongCd || !bun || !ji) {
    console.error("❌ JUSO 응답:", juso);
    throw new Error(
      "주소에서 건축물대장 조회에 필요한 코드(sigunguCd, bjdongCd, bun, ji)를 찾지 못했습니다."
    );
  }

  const jibun = `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`;
  const roadAddr = juso.roadAddr;

  return {
    sigunguCd,
    bjdongCd,
    bun,
    ji,
    jibun,
    roadAddr,
    rawJuso: juso,
  };
}

/**
 * 2. 건축물대장(표제부) 조회
 */
async function fetchBuildingRegister(addressInfo) {
  const { sigunguCd, bjdongCd, bun, ji } = addressInfo;

  // 🔥 엔드포인트 교체!!
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

  const rawText = await res.text();
  console.log("📦 건축물대장 RAW 응답:", rawText);

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`건축물대장 JSON 파싱 실패 → ${rawText}`);
  }

  const header = data.response?.header;
  if (!header || header.resultCode !== "00") {
    throw new Error(
      `건축물대장 조회 실패: ${header?.resultMsg || "알 수 없는 오류"}`
    );
  }

  let items = data.response?.body?.items?.item;
  if (!items) {
    throw new Error("건축물대장 조회 결과가 없습니다.");
  }
  if (!Array.isArray(items)) {
    items = [items];
  }

  return { items };
}


/**
 * 3. 요약(summary) 생성
 */
function buildSummary(items) {
  const apt = items.filter(
    (it) =>
      it.mainPurpsCdNm === "공동주택" &&
      typeof it.etcPurps === "string" &&
      it.etcPurps.includes("공동주택(아파트)") &&
      it.mainAtchGbCdNm === "주건축물"
  );

  const commercial = items.filter(
    (it) =>
      it.mainPurpsCdNm === "제2종근린생활시설" ||
      (typeof it.etcPurps === "string" &&
        it.etcPurps.includes("근린생활시설"))
  );

  const subBuildings = items.filter(
    (it) =>
      it.mainAtchGbCdNm === "부속건축물" &&
      !(
        it.mainPurpsCdNm === "제2종근린생활시설" ||
        (typeof it.etcPurps === "string" &&
          it.etcPurps.includes("근린생활시설"))
      )
  );

  const totalCount = items.length;
  const aptDongCount = apt.length;
  const commercialDongCount = commercial.length;
  const subDongCount = subBuildings.length;

  const totalHousehold = items.reduce(
    (sum, it) => sum + (Number(it.hhldCnt) || 0),
    0
  );

  const aptDongList = apt.map((it) => it.dongNm);

  return {
    totalCount,
    aptDongCount,
    commercialDongCount,
    subDongCount,
    totalHousehold,
    hasCommercial: commercial.length > 0,
    aptDongList,
    apt: apt.map((it) => ({
      dongNm: it.dongNm,
      mainAtchGbCdNm: it.mainAtchGbCdNm,
      mainPurpsCdNm: it.mainPurpsCdNm,
      etcPurps: it.etcPurps,
      totArea: Number(it.totArea),
      grndFlrCnt: Number(it.grndFlrCnt),
      ugrndFlrCnt: Number(it.ugrndFlrCnt),
      hhldCnt: Number(it.hhldCnt),
      roofCdNm: it.roofCdNm,
      strctCdNm: it.strctCdNm,
      useAprDay: it.useAprDay,
      emgenUseElvtCnt: Number(it.emgenUseElvtCnt),
      rideUseElvtCnt: Number(it.rideUseElvtCnt),
    })),
    commercial: commercial.map((it) => ({
      dongNm: it.dongNm,
      mainAtchGbCdNm: it.mainAtchGbCdNm,
      mainPurpsCdNm: it.mainPurpsCdNm,
      etcPurps: it.etcPurps,
      totArea: Number(it.totArea),
      grndFlrCnt: Number(it.grndFlrCnt),
      ugrndFlrCnt: Number(it.ugrndFlrCnt),
      hhldCnt: Number(it.hhldCnt),
      roofCdNm: it.roofCdNm,
      strctCdNm: it.strctCdNm,
      useAprDay: it.useAprDay,
      emgenUseElvtCnt: Number(it.emgenUseElvtCnt),
      rideUseElvtCnt: Number(it.rideUseElvtCnt),
    })),
    subBuildings: subBuildings.map((it) => ({
      dongNm: it.dongNm,
      mainAtchGbCdNm: it.mainAtchGbCdNm,
      mainPurpsCdNm: it.mainPurpsCdNm,
      etcPurps: it.etcPurps,
      totArea: Number(it.totArea),
      grndFlrCnt: Number(it.grndFlrCnt),
      ugrndFlrCnt: Number(it.ugrndFlrCnt),
      hhldCnt: Number(it.hhldCnt),
      roofCdNm: it.roofCdNm,
      strctCdNm: it.strctCdNm,
      useAprDay: it.useAprDay,
      emgenUseElvtCnt: Number(it.emgenUseElvtCnt),
      rideUseElvtCnt: Number(it.rideUseElvtCnt),
    })),
  };
}

/**
 * POST /summary
 */
app.post("/summary", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input || typeof input !== "string") {
      return res.status(400).json({
        error: "잘못된 요청",
        detail: 'body 에 { "input": "주소" } 형식으로 보내주세요.',
      });
    }

    const addressInfo = await searchAddress(input);
    const { items } = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "조회 실패",
      detail: String(err),
    });
  }
});

/**
 * GET /summary?addr=주소  (브라우저용)
 */
app.get("/summary", async (req, res) => {
  try {
    const input = req.query.addr;

    if (!input) {
      return res.status(400).json({
        error: "주소 없음",
        detail:
          "/summary?addr=경기도 양주시 옥정서로 254 이런 식으로 요청해주세요.",
      });
    }

    const addressInfo = await searchAddress(input);
    const { items } = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "조회 실패",
      detail: String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`);
});
