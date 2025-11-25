// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 환경변수 확인
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ELEVATOR_KEY = process.env.ELEVATOR_KEY || MOLIT_KEY;

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY || !ELEVATOR_KEY) {
  console.warn("⚠️ 필수 환경변수 누락: JUSO_KEY, MOLIT_KEY, OPENAI_KEY 확인 필요");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


// ---------------------------------------------------------
// 4. Primary Search: By Elevator Number
// ---------------------------------------------------------
async function getElevatorBaseInfo(elevatorNo) {
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorViewM`);
    const params = {
        serviceKey: ELEVATOR_KEY,
        elevator_no: elevatorNo,
        _type: "json"
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        if (data.response?.header?.resultCode !== "00") return null;
        return data.response?.body?.item || null; 
    } catch (e) {
        return null;
    }
}


// ---------------------------------------------------------
// 5. Data Acquisition & Consolidation
// ---------------------------------------------------------
async function reverseAddressToMolitCode(roadAddr, jibunAddr) {
    const searchAddr = roadAddr || jibunAddr;
    if (!searchAddr) return null;
    const cleanAddr = searchAddr.replace(/\(.*\)/g, '').trim();
    
    const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    const params = {
        confmKey: JUSO_KEY, currentPage: "1", countPerPage: "1", keyword: cleanAddr, resultType: "json",
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        if (!data.results || data.results.common.errorCode !== "0") return null;

        const juso = data.results.juso[0];
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


function getElevatorSummary(elevatorItems) {
    if (!elevatorItems?.length) return { maxFloor: 0 };
    const maxFloor = Math.max(...elevatorItems.map(i => Number(i.divGroundFloorCnt) || 0));
    return { maxFloor };
}


async function findAndGroupAllElevators(baseItem) {
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM`);
    
    const addrParts = baseItem.address1.split(' ');
    const sido = addrParts[0]; 
    const sigungu = addrParts[1]; 
    
    const params = {
        serviceKey: ELEVATOR_KEY, pageNo: "1", numOfRows: "100", _type: "json",
        sido: sido, 
        sigungu: sigungu, 
        buld_nm: baseItem.buldNm, 
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    const fallbackResult = { 
        count: 1, 
        items: [baseItem], 
        hasEvacElevator: (baseItem.elvtrKindNm && baseItem.elvtrKindNm.includes('피난')) || false,
        maxFloor: Number(baseItem.divGroundFloorCnt) || 0 
    };

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        if (data.response?.header?.resultCode !== "00") return fallbackResult;
        
        const rawItems = data.response?.body?.items?.item;
        const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
        if (items.length === 0) return fallbackResult;

        const sameBuildingElevators = items.filter(item => 
            String(item.buldMgtNo1) === String(baseItem.buldMgtNo1) && 
            String(item.buldMgtNo2) === String(baseItem.buldMgtNo2)
        );

        if (sameBuildingElevators.length === 0) return fallbackResult;

        const hasEvacElevator = sameBuildingElevators.some(i => i.elvtrKindNm && i.elvtrKindNm.includes('피난'));
        const maxFloorInGroup = getElevatorSummary(sameBuildingElevators).maxFloor;

        return { 
            count: sameBuildingElevators.length, 
            items: sameBuildingElevators, 
            hasEvacElevator: hasEvacElevator, 
            maxFloor: maxFloorInGroup 
        };
    } catch (e) {
        return fallbackResult;
    }
}

async function fetchBuildingRegister(molitCodes) { 
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`);
  const params = { 
    serviceKey: MOLIT_KEY, sigunguCd: molitCodes.sigunguCd, bjdongCd: molitCodes.bjdongCd, 
    platGbCd: "0", bun: molitCodes.bun, ji: molitCodes.ji, 
    _type: "json", numOfRows: "100", pageNo: "1" 
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  try {
    const res = await fetch(url.toString());
    const text = await res.text();
    if (!res.ok) return [];
    const data = JSON.parse(text);
    if (data.response?.header?.resultCode !== "00") return [];
    const rawItems = data.response?.body?.items?.item;
    return Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
  } catch (e) { return []; }
}

function buildMolitSummary(items) { 
    const filtered = items.filter(it => {
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;
        if (grndFlrCnt === 0) return false;
        return true; 
    });
    
    const maxFloor = filtered.length ? Math.max(...filtered.map(it => Number(it.grndFlrCnt) || 0)) : 0;
    const daJungList = filtered.filter(it => ["공동주택", "제2종근린생활시설", "문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));
    const gaMokArea = daJungList.filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm)).reduce((sum, it) => sum + Number(it.totArea), 0);
    const gaMokType = daJungList.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));

    return { totalCount: filtered.length, maxFloor, gaMokArea, gaMokType: gaMokType ? gaMokType.mainPurpsCdNm : null, items: daJungList };
}



// ============================================================
// 🚨 7. LLM AI Judge: AI 주도형 판단 — 프롬프트 완전 수정본
// ============================================================
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
  "reason": "조건 평가(evac, finalFloor, gaMokExists, gaMokArea)를 포함, TRUE/FALSE 평가",
  "explanation": "화면 표시용 최종 한글 문장. 반드시 템플릿 그대로 사용, {usage}와 {reason} 치환"
}

[템플릿 — explanation에만 적용]
- finalResult == "다중이용건축물-피난":
  "해당 건물은 피난용 엘리베이터가 설치되어 있는 고층건축물로 판단됩니다. 피난용 엘리베이터 승강기 관리교육 이수가 필요합니다."
- finalResult == "다중이용건축물":
  "해당 건물의 용도는 {usage}이며, {reason} 이므로 다중이용건축물로 판단됩니다. 비상구출운전 승강기관리교육 이수가 필요합니다."
- finalResult == "일반건축물":
  "해당 건물은 일반건축물로 판단됩니다. 승강기 관리교육 이수가 필요합니다."

[입력값 — 반드시 이 값을 사용]
evac = ${hasEvac}
finalFloor = ${finalFloor}
gaMokExists = ${gaMokExists}
gaMokArea = ${area}
usage = "${usage}"

[예시 JSON — 반드시 이 형식, JSON 외 출력 금지]
{
  "code": "BLUE",
  "decision_text": "일반건축물",
  "reason": "evac=false(FALSE), finalFloor=15(<16), gaMokExists=false(FALSE), gaMokArea=0(<5000) 조건 평가",
  "explanation": "해당 건물은 일반건축물로 판단됩니다. 승강기 관리교육 이수가 필요합니다."
}
`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0,
            max_tokens: 500
        });

        const content = response.choices[0].message.content.trim();
        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            const jsonStr = content.substring(jsonStart, jsonEnd + 1);
            return JSON.parse(jsonStr);
        }

        return {
            code: "BLUE",
            decision_text: "일반건축물",
            reason: `evac=${hasEvac}, finalFloor=${finalFloor}, gaMokExists=${gaMokExists}, gaMokArea=${area} 조건 평가`,
            explanation: "해당 건물은 일반건축물로 판단됩니다. 승강기 관리교육 이수가 필요합니다."
        };
    } catch (err) {
        return {
            code: "BLUE",
            decision_text: "일반건축물",
            reason: "AI 연결 실패",
            explanation: "해당 건물은 일반건축물로 판단됩니다. 승강기 관리교육 이수가 필요합니다."
        };
    }
}

// ---------------------------------------------------------
// 9. API 핸들러
// ---------------------------------------------------------
async function apiSummaryHandler(req, res) {
    try {
        const input = req.body.addr; 
        if (!input) return res.status(400).json({ error: "승강기 번호가 필요합니다." });

        const baseItem = await getElevatorBaseInfo(input); 
        if (!baseItem) return res.status(404).json({ error: "승강기 번호 조회 실패", detail: "일치하는 승강기 정보가 없습니다." });
        
        const groupResult = await findAndGroupAllElevators(baseItem);
        const finalMaxFloor = groupResult.maxFloor;
        const hasEvacElevator = groupResult.hasEvacElevator;
        
        let molitSummary = { totalCount: 0, maxFloor: 0, gaMokArea: 0, items: [] };
        let molitStatus = "SKIPPED";

        if (!hasEvacElevator && finalMaxFloor < 16) {
            const molitCodes = await reverseAddressToMolitCode(baseItem.address1);
            if (molitCodes) {
                const molitItems = await fetchBuildingRegister(molitCodes);
                molitSummary = buildMolitSummary(molitItems);
                molitStatus = molitItems.length > 0 ? "SUCCESS" : "NO_DATA";
            } else {
                molitStatus = "FAILED";
            }
        }
        
        const llmResult = await getLLMJudge(molitSummary, groupResult, baseItem);

        const gradeCode = llmResult.code;
        let gradeTitle;

        if (llmResult.decision_text.includes("피난")) {
            gradeTitle = '피난용 엘리베이터 승강기 관리교육(12시간)';
        } else if (gradeCode === 'RED') {
            gradeTitle = '비상구출운전 승강기관리교육(12시간)';
        } else {
            gradeTitle = '승강기 관리교육(4시간)';
        }

        const themeColor = gradeCode === 'RED' ? 'blue' : 'green'; 

        const rawUsage = baseItem.buldPrpos || '공동주택/기타';
        const refinedUsage = rawUsage.split('-')[0].trim(); 

        res.json({
            status: "ok",
            uiRender: {
                badgeText: llmResult.decision_text,
                colorTheme: themeColor,
                mainTitle: gradeTitle,
                description: llmResult.explanation
            },
            addressInfo: { roadAddr: baseItem.address2, jibun: baseItem.address1 },
            analysis: {
                ruleBased: gradeCode,
                llmFinalDecision: llmResult.decision_text,
                llmReason: llmResult.reason
            },
            data: {
                address: baseItem.address2,
                molit: { floor: molitSummary.maxFloor, area: molitSummary.gaMokArea },
                elevator: { floor: groupResult.maxFloor, count: groupResult.count },
                source: "승강기 번호 직접 조회"
            },
            summaryDetails: {
                총건물수: molitSummary.totalCount,
                최고지상층수: molitSummary.maxFloor,
                가목_연면적_합계: molitSummary.gaMokArea,
                elevatorCount: groupResult.count,
                elevatorMaxFloor: groupResult.maxFloor,
                buldPrpos: refinedUsage,
                molitStatus: molitStatus
            },
            raw: { baseElevatorItem: baseItem, molitItems: molitSummary.items }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
    }
}


// ---------------------------------------------------------
app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));



