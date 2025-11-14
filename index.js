// index.js (CommonJS 버전)

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

// 6. 한글화 & 연면적 포함
function buildSummary(items) {
  const 아파트 = items.filter(it =>
    it.mainPurpsCdNm === "공동주택" &&
    typeof it.etcPurps === "string" &&
    it.etcPurps.includes("공동주택(아파트)") &&
    it.mainAtchGbCdNm === "주건축물"
  );

  const 상업 = items.filter(it =>
    it.mainPurpsCdNm === "제2종근린생활시설" ||
    (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
  );

  const 부속 = items.filter(it =>
    it.mainAtchGbCdNm === "부속건축물" &&
    !(it.mainPurpsCdNm === "제2종근린생활시설" ||
      (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설")))
  );

  // 연면적 totArea 기준으로 보장
  function getTotalArea(it) {
    return Number(it.totArea || 0);
  }

  return {
    아파트: 아파트.map(it => ({ ...it, 연면적: getTotalArea(it) })),
    상업: 상업.map(it => ({ ...it, 연면적: getTotalArea(it) })),
    부속건물: 부속.map(it => ({ ...it, 연면적: getTotalArea(it) })),
  };
}

// 7. 다중이용건축물 판단
function isMultiUseBuilding(summary) {
  const allBuildings = summary.아파트.concat(summary.상업).concat(summary.부속건물);
  const multiUseAreaThreshold = 5000;

  const 가목대상 = allBuildings.filter(it =>
    ["문화 및 집회시설","종교시설","판매시설","운수시설","의료시설","숙박시설"]
      .some(u => it.mainPurpsCdNm.includes(u)) && it.연면적 >= multiUseAreaThreshold
  );

  const 나목대상 = allBuildings.filter(it => it.grndFlrCnt >= 16);

  const 결과 = 가목대상.length > 0 || 나목대상.length > 0;
  return {
    다중이용건축물: 결과,
    판단이유: 결과 ? `가목: ${가목대상.length}개, 나목: ${나목대상.length}개` : "가목·나목 해당 없음",
  };
}

// 8. API 라우트 (/summary)
app.get("/summary", async (req, res) => {
  try {
    const input = req.query.addr;
    if (!input) return res.status(400).json({ error: "주소 필요" });

    const addressInfo = await searchAddress(input);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const multiUse = isMultiUseBuilding(summary);

    // 다중이용건축물 여부만 반환
    res.json({
      주소: input,
      다중이용건축물: multiUse.다중이용건축물,
      판단이유: multiUse.판단이유,
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
