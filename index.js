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

// 6. 한글화 & 요약 (기타 용도 통합 필터링)
function buildSummary(items) {
  // 다중이용건축물 관련 용도 필터링 (기타 용도 통합)
  const 다중이용건물 = items.filter(it =>
    [
      "공동주택",  // 아파트
      "제2종근린생활시설",  // 상업시설
      "문화 및 집회시설",  // 문화시설
      "종교시설",  // 종교시설
      "판매시설",  // 판매시설
      "운수시설",  // 운수시설
      "의료시설",  // 의료시설
      "숙박시설",  // 숙박시설
    ].includes(it.mainPurpsCdNm) || (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
  );

  // 총 연면적 계산 (다중이용건물만)
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

// 7. 다중이용건축물 판단 (수정)
function isMultiUseBuilding(summary) {
  const multiUseAreaThreshold = 5000;

  // 가목: 특정 용도 + 연면적 5천 이상
  const 가목대상 = summary.아파트.concat(summary.상업).concat(summary.부속건물)
    .filter(it =>
      ["문화 및 집회시설","종교시설","판매시설","운수시설","의료시설","숙박시설"]
        .some(u => it.용도.includes(u)) && it.연면적 >= multiUseAreaThreshold
    );

  // 나목: 지상층 16층 이상만 체크 (연면적 무시)
  const 나목대상 = summary.아파트.concat(summary.상업).concat(summary.부속건물)
    .filter(it => it.지상층 >= 16);

  const 결과 = 가목대상.length > 0 || 나목대상.length > 0;

  return {
    다중이용건축물: 결과,
    판단이유: 결과
      ? `가목: ${가목대상.length}개, 나목: ${나목대상.length}개`
      : "가목·나목 해당 없음",
  };
}

// 8. API 라우트 (/summary) - 다중이용건축물 판단만 반환
app.get("/summary", async (req, res) => {
  try {
    const input = req.query.addr;
    if (!input) return res.status(400).json({ error: "주소 필요" });

    const addressInfo = await searchAddress(input);
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const multiUse = isMultiUseBuilding(summary);

    // summary 제거하고 다중이용건축물 정보만 반환
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


