// server.js
const express = require("express");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. 환경변수 및 OpenAI 설정
const { JUSO_KEY, MOLIT_KEY, OPENAI_KEY, ELEVATOR_KEY } = process.env;
const SERVICE_KEY_ELEVATOR = ELEVATOR_KEY || MOLIT_KEY;

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY || !SERVICE_KEY_ELEVATOR) {
  console.warn("⚠️ [경고] 필수 환경변수가 누락되었습니다.");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 2. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =================================================================
// 3. Helper Functions (API Calls)
// =================================================================

// [API] 승강기 고유번호로 기본 정보 조회
async function getElevatorBaseInfo(elevatorNo) {
  const url = new URL("https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorViewM");
  url.searchParams.append("serviceKey", SERVICE_KEY_ELEVATOR);
  url.searchParams.append("elevator_no", elevatorNo);
  url.searchParams.append("_type", "json");

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.response?.header?.resultCode !== "00") return null;
    return data.response?.body?.item || null;
  } catch (e) {
    console.error("Elevator API Error:", e.message);
    return null;
  }
}

// [API] 주소를 관할 구역 코드(SigunguCd 등)로 변환
async function reverseAddressToMolitCode(roadAddr, jibunAddr) {
  const searchAddr = (roadAddr || jibunAddr || "").replace(/\(.*\)/g, '').trim();
  if (!searchAddr) return null;

  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  url.searchParams.append("confmKey", JUSO_KEY);
  url.searchParams.append("currentPage", "1");
  url.searchParams.append("countPerPage", "1");
  url.searchParams.append("keyword", searchAddr);
  url.searchParams.append("resultType", "json");

  try {
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.results?.common?.errorCode !== "0") return null;
    const juso = data.results?.juso?.[0];
    if (!juso) return null;

    return {
      sigunguCd: juso.admCd.substring(0, 5),
      bjdongCd: juso.admCd.substring(5, 10),
      bun: String(juso.lnbrMnnm || "").padStart(4, "0"),
      ji: String(juso.lnbrSlno || "").padStart(4, "0"),
      roadAddr: juso.roadAddr,
      jibunAddr: juso.jibunAddr
    };
  } catch (e) {
    return null;
  }
}

// [API] 해당 건물의 모든 승강기 조회 및 그룹화
async function findAndGroupAllElevators(baseItem) {
  const fallbackResult = {
    count: 1,
    items: [baseItem],
    hasEvacElevator: baseItem.elvtrKindNm?.includes('피난') || false,
    maxFloor: Number(baseItem.divGroundFloorCnt) || 0
  };

  try {
    const addrParts = (baseItem.address1 || "").split(' ');
    if (addrParts.length < 2) return fallbackResult;

    const url = new URL("https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM");
    url.searchParams.append("serviceKey", SERVICE_KEY_ELEVATOR);
    url.searchParams.append("pageNo", "1");
    url.searchParams.append("numOfRows", "100"); // 한 건물에 100대 이상일 확률은 낮음
    url.searchParams.append("_type", "json");
    url.searchParams.append("sido", addrParts[0]);
    url.searchParams.append("sigungu", addrParts[1]);
    url.searchParams.append("buld_nm", baseItem.buldNm || "");

    const res = await fetch(url);
    const data = await res.json();
    
    if (data.response?.header?.resultCode !== "00") return fallbackResult;

    const rawItems = data.response?.body?.items?.item;
    const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);

    // 같은 건물 관리번호(buldMgtNo1, 2)를 가진 승강기만 필터링
    const sameBuildingElevators = items.filter(item => 
      String(item.buldMgtNo1) === String(baseItem.buldMgtNo1) && 
      String(item.buldMgtNo2) === String(baseItem.buldMgtNo2)
    );

    if (sameBuildingElevators.length === 0) return fallbackResult;

    const hasEvacElevator = sameBuildingElevators.some(i => i.elvtrKindNm && i.elvtrKindNm.includes('피난'));
    const maxFloor = Math.max(...sameBuildingElevators.map(i => Number(i.divGroundFloorCnt) || 0));

    return {
      count: sameBuildingElevators.length,
      items: sameBuildingElevators,
      hasEvacElevator,
      maxFloor
    };
  } catch (e) {
    return fallbackResult;
  }
}

// [API] 건축물대장 표제부 조회
async function fetchBuildingRegister(molitCodes) {
  const url = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo");
  url.searchParams.append("serviceKey", MOLIT_KEY);
  url.searchParams.append("sigunguCd", molitCodes.sigunguCd);
  url.searchParams.append("bjdongCd", molitCodes.bjdongCd);
  url.searchParams.append("platGbCd", "0");
  url.searchParams.append("bun", molitCodes.bun);
  url.searchParams.append("ji", molitCodes.ji);
  url.searchParams.append("_type", "json");
  url.searchParams.append("numOfRows", "100");

  try {
    const res = await fetch(url);
    // 공공데이터포털은 가끔 JSON 응답 헤더가 올바르지 않거나 XML이 섞일 때가 있어 text로 받고 파싱
    const text = await res.text();
    const data = JSON.parse(text);
    
    if (data.response?.header?.resultCode !== "00") return [];
    const rawItems = data.response?.body?.items?.item;
    return Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
  } catch (e) {
    return [];
  }
}

// [Logic] 건축물대장 정보 요약 (가목 시설 판단 로직 포함)
function buildMolitSummary(items) {
  // 지상층수가 0인 데이터(철거됨 등) 제외
  const filtered = items.filter(it => (Number(it.grndFlrCnt) || 0) > 0);
  
  if (!filtered.length) return { totalCount: 0, maxFloor: 0, gaMokArea: 0, items: [] };

  const maxFloor = Math.max(...filtered.map(it => Number(it.grndFlrCnt) || 0));

  // 다중이용건축물 '가'목에 해당하는 용도군
  const targetPurposes = ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"];
  
  const daJungList = filtered.filter(it => targetPurposes.includes(it.mainPurpsCdNm));
  const gaMokArea = daJungList.reduce((sum, it) => sum + (Number(it.totArea) || 0), 0);
  
  // 대표적인 용도 하나 추출
  const gaMokTypeItem = daJungList.find(it => targetPurposes.includes(it.mainPurpsCdNm));

  return { 
    totalCount: filtered.length, 
    maxFloor, 
    gaMokArea, 
    gaMokType: gaMokTypeItem ? gaMokTypeItem.mainPurpsCdNm : null, 
    items: daJungList 
  };
}

// =================================================================
// 4. AI Judge Logic (Optimized)
// =================================================================
async function getLLMJudge(molitSummary, elevatorSummary, baseItem) {
  const finalFloor = Math.max(molitSummary.maxFloor || 0, elevatorSummary.maxFloor || 0);
  const area = molitSummary.gaMokArea || 0;
  const gaMokExists = area > 0;
  const hasEvac = elevatorSummary.hasEvacElevator;
  
  const rawUsage = baseItem.buldPrpos || '공동주택/기타';
  const usage = rawUsage.split('-')[0].trim();
  const prompt = `
당신은 법적 판정 전용 AI입니다. 자연어 추론, 연역, 추정, 보정 등은 절대 사용하지 마십시오.
Boolean 규칙과 수치 비교만 사용하여 최종 결과를 산출합니다.

[판정 규칙]
1) evac == true → "다중이용건축물-피난"
2) evac == false AND (finalFloor >= 16 OR (gaMokExists == true AND gaMokArea >= 5000)) → "다중이용건축물"
3) 위 조건 모두 아니면 → "일반건축물"

[출력 JSON — 반드시 이 형식으로 출력]
{
  "code": "RED 또는 BLUE",
  "decision_text": "다중이용건축물-피난 / 다중이용건축물 / 일반건축물 중 하나",
  "reason": "조건 평가와 입력값(evac, finalFloor, gaMokExists, gaMokArea)을 포함",
  "explanation": "최종 화면용 안내, 영어/괄호 없이 한국어로만 작성"
}

[추가 규칙]
- explanation에는 영어, TRUE/FALSE, 괄호를 사용하지 말고, 한국어 문장으로 명확히 표현
- explanation에는 {usage}, {evac 상태}, {최고층수}, {가목 시설 여부}, {가목 연면적} 정보를 포함
- reason에는 내부용으로 정확한 조건 평가를 JSON/영문 그대로 포함
- 출력은 반드시 JSON 하나만 생성

[템플릿]
- finalResult == "다중이용건축물-피난":
  "해당 건물은 피난용 엘리베이터가 설치되어 있는 고층건축물로 판단됩니다. 피난용 엘리베이터 승강기 관리교육 이수가 필요합니다."
- finalResult == "다중이용건축물":
  "해당 건물의 용도는 {usage}이며, 피난용 엘리베이터 없음, 최고층수 {finalFloor}층 이상, 가목 시설 {gaMokExists ? '있음' : '없음'}, 가목 연면적 {gaMokArea}㎡ 조건 평가 이므로 다중이용건축물로 판단됩니다. 비상구출운전 승강기관리교육 이수가 필요합니다."
- finalResult == "일반건축물":
  "해당 건물은 일반건축물로 판단됩니다. 승강기 관리교육 이수가 필요합니다."

[입력값]
evac = ${hasEvac}
finalFloor = ${finalFloor}
gaMokExists = ${gaMokExists}
gaMokArea = ${area}
usage = "${usage}"

[예시 JSON — 반드시 이 형식, JSON 외 출력 금지]
{
  "code": "BLUE",
  "decision_text": "일반건축물",
  "reason": "evac=false, finalFloor=15(<16), gaMokExists=false, gaMokArea=0 조건 평가",
  "explanation": "해당 건물은 일반건축물로 판단됩니다. 승강기 관리교육 이수가 필요합니다."
}
`;


  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // 최신 가성비 모델 변경 (gpt-4.1-mini는 존재하지 않음)
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" }, // JSON 모드 강제
      temperature: 0.0,
      max_tokens: 400
    });

    return JSON.parse(response.choices[0].message.content);

  } catch (err) {
    console.error("OpenAI Error:", err);
    // Fallback Logic (AI 실패 시 룰베이스로 처리)
    let decision = "일반건축물";
    if (hasEvac) decision = "다중이용건축물-피난";
    else if (finalFloor >= 16 || (gaMokExists && area >= 5000)) decision = "다중이용건축물";
    
    return {
      code: decision.includes("다중") ? "RED" : "BLUE",
      decision_text: decision,
      reason: "AI 응답 지연으로 인한 자동 룰베이스 판정",
      explanation: `시스템 규칙에 따라 ${decision}로 판단됩니다.`
    };
  }
}

// =================================================================
// 5. Main Handler
// =================================================================
async function apiSummaryHandler(req, res) {
  try {
    const input = req.body.addr;
    if (!input) return res.status(400).json({ error: "승강기 번호가 필요합니다." });

    // 1. 기본 승강기 정보 조회
    const baseItem = await getElevatorBaseInfo(input);
    if (!baseItem) {
      return res.status(404).json({ error: "조회 실패", detail: "일치하는 승강기 정보가 없습니다." });
    }

    // 2. 승강기 전체 그룹핑 (같은 건물 내)
    const groupResult = await findAndGroupAllElevators(baseItem);
    
    // 3. 건축물대장 조회 조건 확인
    // 피난용이 있거나 이미 16층 이상이면 건축물대장 조회가 필수는 아니지만,
    // 정확도를 위해 조회하되, 실패해도 로직은 진행되도록 구성
    let molitSummary = { totalCount: 0, maxFloor: 0, gaMokArea: 0, items: [] };
    let molitStatus = "SKIPPED";

    // (최적화) 필요할 때만 대장 조회
    if (!groupResult.hasEvacElevator) {
        const molitCodes = await reverseAddressToMolitCode(baseItem.address1);
        if (molitCodes) {
            const molitItems = await fetchBuildingRegister(molitCodes);
            molitSummary = buildMolitSummary(molitItems);
            molitStatus = molitItems.length > 0 ? "SUCCESS" : "NO_DATA";
        } else {
            molitStatus = "FAILED";
        }
    }

    // 4. AI 판단 수행
    const llmResult = await getLLMJudge(molitSummary, groupResult, baseItem);

    // 5. 교육 제목 매핑
    let gradeTitle = '승강기 관리교육(4시간)';
    if (llmResult.decision_text === "다중이용건축물-피난") {
        gradeTitle = '피난용 엘리베이터 승강기 관리교육(12시간)';
    } else if (llmResult.decision_text === "다중이용건축물") {
        gradeTitle = '비상구출운전 승강기관리교육(12시간)';
    }

    const themeColor = llmResult.code === 'RED' ? 'red' : 'blue'; // 원본 코드 로직 유지 (red -> blue text error fix)

    // 응답 전송
    res.json({
      status: "ok",
      uiRender: {
        badgeText: llmResult.decision_text,
        colorTheme: themeColor,
        mainTitle: gradeTitle,
        description: llmResult.explanation
      },
      summaryDetails: {
        최고지상층수: Math.max(molitSummary.maxFloor, groupResult.maxFloor),
        가목_연면적_합계: molitSummary.gaMokArea,
        elevatorCount: groupResult.count,
        hasEvacElevator: groupResult.hasEvacElevator,
        buldPrpos: (baseItem.buldPrpos || "").split('-')[0].trim(),
        molitStatus
      },
      raw: { baseElevatorItem: baseItem } // 디버깅용
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
  }
}

app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
