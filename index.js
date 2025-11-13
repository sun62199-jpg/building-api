// index.js (CommonJS 버전)

// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// 🔥 node-fetch v3 (ESM 전용)를 CommonJS에서 쓰는 방법
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

// 정적 파일 (public 폴더에 index.html 넣어둔 상태)
app.use(express.static(path.join(__dirname, "public")));

// 4. JUSO 주소 검색 함수
async function searchAddress(input) {
  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");

  const params = {
    confmKey: process.env.JUSO_KEY,
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
      `주소 검색 실패: ${data.results?.common?.errorMessage || "알 수 없는 오류"}`
    );
  }

  const juso = data.results.juso[0];
  if (!juso) {
    throw new Error("검색 결과가 없습니다.");
  }

  // 🔥 여기부터 “직접 계산”하는 부분
  const admCd = juso.admCd; // 예: '1168010500'
  const sigunguCd = admCd.substring(0, 5); // 11680
  const bjdongCd = admCd.substring(5, 10); // 10500

  const bun = String(juso.lnbrMnnm || "").padStart(4, "0"); // 157 → 0157
  const ji = String(juso.lnbrSlno || "").padStart(4, "0"); // 37  → 0037

  const jibun = `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`;
  const roadAddr = juso.roadAddr;

  const addressInfo = {
    sigunguCd,
    bjdongCd,
    bun,
    ji,
    jibun,
    roadAddr,
    rawJuso: juso,
  };

  console.log("🏠 addressInfo:", addressInfo);

  return addressInfo;
}

// 5. 건축물대장(표제부) 조회 + 디버그 강화
async function fetchBuildingRegister(addressInfo) {
  const { sigunguCd, bjdongCd, bun, ji } = addressInfo;

  const url = new URL(
    "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo"
  );

  const params = {
    serviceKey: process.env.MOLIT_KEY,
    sigunguCd,
    bjdongCd,
    platGbCd: "0", // 산이면 나중에 addressInfo에서 넘기도록
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

  if (!res.ok) {
    throw new Error(`건축물대장 API 오류: HTTP ${res.status} / BODY: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("건축물대장 JSON 파싱 실패 → " + text);
  }

  const header = data.response?.header;
  if (!header || header.resultCode !== "00") {
    throw new Error(
      `건축물대장 조회 실패: ${header?.resultMsg || "알 수 없는 오류"}`
    );
  }

  const items = data.response?.body?.items?.item;
  if (!items || items.length === 0) {
    throw new Error("건축물대장 조회 결과가 없습니다.");
  }

  return { items };
}

// 6. 요약(summary) 한글로 만드는 함수
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
      (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
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

  // 요약 숫자들
  const 총건물수 = items.length;
  const 아파트동수 = apt.length;
  const 상가동수 = commercial.length;
  const 부속건물수 = subBuildings.length;

  const 총세대수 = items.reduce(
    (sum, it) => sum + (Number(it.hhldCnt) || 0),
    0
  );

  const 아파트동목록 = apt.map((it) => it.dongNm);

  // 상세 정보 → 한글 필드 매핑
  const mapToKorean = (it) => ({
    동이름: it.dongNm,
    건물구분: it.mainAtchGbCdNm,
    주용도: it.mainPurpsCdNm,
    기타용도: it.etcPurps,
    연면적_m2: Number(it.totArea),
    지상층수: Number(it.grndFlrCnt),
    지하층수: Number(it.ugrndFlrCnt),
    세대수: Number(it.hhldCnt),
    지붕구조: it.roofCdNm,
    주구조: it.strctCdNm,
    사용승인일: it.useAprDay,
    비상용승강기수: Number(it.emgenUseElvtCnt),
    승객용승강기수: Number(it.rideUseElvtCnt),
  });

  return {
    총건물수,
    아파트동수,
    상가동수,
    부속건물수,
    총세대수,
    상가존재: commercial.length > 0,
    아파트동목록,
    아파트: apt.map(mapToKorean),
    상가: commercial.map(mapToKorean),
    부속건물: subBuildings.map(mapToKorean),
  };
}

// 7. API 라우트

// POST /summary  (카카오톡/백엔드용)
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

// GET /summary?addr=...  (브라우저 테스트용)
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

// 루트(/)는 public/index.html 제공
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 8. 서버 시작
app.listen(PORT, () => {
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`);
});
