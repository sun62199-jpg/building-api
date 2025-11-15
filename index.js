// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3(CommonJS에서 ESM 사용)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// 환경변수
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;

// 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


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
    throw new Error(`주소 검색 실패: ${data.results?.common?.errorMessage}`);
  }

  const juso = data.results.juso[0];
  if (!juso) throw new Error("검색 결과 없음");

  const admCd = juso.admCd;

  return {
    sigunguCd: admCd.substring(0, 5),
    bjdongCd: admCd.substring(5, 10),
    bun: String(juso.lnbrMnnm || "").padStart(4, "0"),
    ji: String(juso.lnbrSlno || "").padStart(4, "0"),
    roadAddr: juso.roadAddr, // 전체 도로명 주소
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
    numOfRows: "200",
    pageNo: "1",
    _type: "json",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url.toString());
  const raw = await res.text();

  if (!res.ok) throw new Error("건축물대장 API 오류");

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("건축물대장 JSON 파싱 실패");
  }

  const items = data.response?.body?.items?.item;
  if (!items) throw new Error("건축물대장 조회 결과 없음");

  return Array.isArray(items) ? items : [items];
}



// 6. 요약 정보 생성
function buildSummary(items) {
  return items.map(it => ({
    동: it.dongNm,
    용도: it.mainPurpsCdNm,
    기타용도: it.etcPurps,
    연면적: Number(it.totArea) || 0,
    지상층: Number(it.grndFlrCnt) || 0,
  }));
}



// 7. 다중이용건축물 판단
function evaluateMultiUse(summary) {
  // 가항목 시설군
  const 시설군 = {
    "문화 및 집회시설": "문화 및 집회시설",
    "종교시설": "종교시설",
    "판매시설": "판매시설",
    "운수시설": "운수시설",
    "의료시설": "의료시설",
    "숙박시설": "숙박시설",
  };

  // 가항목 판단 (연면적 5,000 이상이면 '해당')
  const 가항목 = {};
  const requiredArea = 5000;

  // 시설별 분류
  for (const key of Object.keys(시설군)) {
    const 해당동 = summary.filter(it => it.용도 === key);
    const 총연면적 = 해당동.reduce((s, it) => s + it.연면적, 0);

    가항목[key] = 총연면적 >= requiredArea ? "해당" : "해당없음";
  }

  // 나항목: 최고 지상층
  const 최고층 = Math.max(...summary.map(it => it.지상층));
  const 나항목 = { "최고 지상층수": 최고층 };

  // 최종 판단
  const 가_해당 = Object.values(가항목).includes("해당");
  const 나_해당 = 최고층 >= 16;
  const 최종판단 = 가_해당 || 나_해당 ? "예" : "아니오";

  return {
    isMultiUse: 최종판단,
    criteria: {
      가: 가항목,
      나: 나항목,
    },
  };
}



// 8. API 라우트
app.get("/summary", async (req, res) => {
  try {
    const addr = req.query.addr;
    if (!addr) return res.status(400).json({ error: "주소 필요" });

    const addressInfo = await searchAddress(addr);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const result = evaluateMultiUse(summary);

    res.json({
      address: addressInfo.roadAddr,
      isMultiUse: result.isMultiUse,
      criteria: result.criteria,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "조회 실패", detail: err.message });
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
