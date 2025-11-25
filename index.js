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
// 🚨 7. LLM AI Judge: AI 주도형 판단 (용도 정제 적용)
// ============================================================
async function getLLMJudge(molitSummary, elevatorSummary, baseItem) {
    const finalFloor = Math.max(molitSummary.maxFloor || 0, elevatorSummary.maxFloor || 0);
    const area = molitSummary.gaMokArea || 0;
    
    // 🚨 FIX: 용도 문자열 정제 (부용도 제거)
    const rawUsage = baseItem.buldPrpos || '공동주택/기타';
    const usage = rawUsage.split('-')[0].trim(); 

    const hasEvac = elevatorSummary.hasEvacElevator; // Boolean
    
    // 🚨 AI에게 판단을 전적으로 맡기는 프롬프트
   const prompt = `
[ROLE] 당신은 법령 판정 전용 AI입니다. 아래 규칙을 하나라도 어기면 "잘못된 출력"으로 간주됩니다.
어떤 이유로도 규칙을 수정, 삭제, 추가, 완화할 수 없습니다. 오직 아래 판결 기준만 적용하세요.
JSON 외의 어떤 텍스트도 출력하지 마십시오.

[증거 데이터]
1. evac: ${hasEvac ? "TRUE" : "FALSE"}  // 피난용 승강기 설치 여부
2. finalFloor: ${finalFloor}            // 최고 층수 (정수)
3. usage: "${usage}"                    // 정제된 건물 용도(문자열)
4. gaMokArea: ${area.toFixed(2)}       // 가목 연면적 합계 (숫자)
5. gaMokType: ${molitSummary.gaMokType ? `"${molitSummary.gaMokType}"` : "null"} // 대표 가목 용도 또는 null

[판결 기준 — 절대 변경 금지]
1) 다중이용건축물-피난: evac === TRUE -> 반드시 이 등급.
2) 다중이용건축물: evac === FALSE AND ( finalFloor >= 16 OR (gaMokType != null AND gaMokArea >= 5000.00) ) -> 해당.
3) 일반건축물: 위 1,2 모두 해당하지 않을 때만 해당.

[출력 요구사항 — JSON ONLY]
- 출력은 오직 하나의 JSON 객체여야 함. (문장/설명 금지)
- 정확한 키(대소문자 포함)를 사용해야 함.

JSON 스키마:
{
  "code": "RED" | "BLUE" | "REJECT",
  "decision_text": "다중이용건축물-피난" | "다중이용건축물" | "일반건축물" | "REJECT",
  "reason": "간단한 판결 이유 (숫자 비교 포함, 한 문장)",
  "checks": {
    "evac_check": "TRUE or FALSE (예: FALSE -> 피난용 승강기 없음)",
    "floor_check": "TRUE or FALSE (예: 4 >= 16 -> FALSE)",
    "gaMokType_check": "TRUE or FALSE (예: 판매시설 존재 -> TRUE)",
    "area_check": "TRUE or FALSE (예: 31417.82 >= 5000.00 -> TRUE)"
  }
}

[무결성 규칙 — 반드시 준수]
1) 모델이 내부적으로 위 스키마에 맞춰 checks 를 계산해야 한다.
2) 모델이 계산한 checks 에 비추어 expectedDecision을 유도하고, 그 expectedDecision이 decision_text와 **정확히 일치하지 않으면** 반드시 code="REJECT" 와 decision_text="REJECT" 를 반환해야 한다.
3) reason 은 checks 와 결론(=decision_text)을 숫자 비교 문구로 요약해야 한다.
4) 절대 규칙: JSON 외 추가 텍스트 금지.

(끝)

`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0, 
            max_tokens: 400,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(content.substring(s, e + 1));
        
        return { code: "BLUE", decision_text: "일반건축물", reason: "AI 판단 중 오류가 발생하여 일반 건축물로 간주합니다." };
    } catch (e) {
        return { code: "BLUE", decision_text: "일반건축물", reason: "AI 서비스 연결 실패. 일반 건축물로 간주합니다." };
    }
}

// 9. API 핸들러
async function apiSummaryHandler(req, res) {
    try {
        const input = req.body.addr; 
        if (!input) return res.status(400).json({ error: "승강기 번호가 필요합니다." });

        // 1. 승강기 번호 조회
        const baseItem = await getElevatorBaseInfo(input); 
        if (!baseItem) return res.status(404).json({ error: "승강기 번호 조회 실패", detail: "일치하는 승강기 정보가 없습니다." });
        
        // 2. 건물 통합
        const groupResult = await findAndGroupAllElevators(baseItem);
        const finalMaxFloor = groupResult.maxFloor;
        const hasEvacElevator = groupResult.hasEvacElevator;
        
        let molitSummary = { totalCount: 0, maxFloor: 0, gaMokArea: 0, items: [] };
        let molitStatus = "SKIPPED"; 

        // 3. MOLIT 조회 (16층 미만이고 피난용 없으면 조회 시도)
        if (!hasEvacElevator && finalMaxFloor < 16) {
            // 🚨 FIX: address1(메인주소) 사용 (V11.8 반영)
            const molitCodes = await reverseAddressToMolitCode(baseItem.address1);
            if (molitCodes) {
                const molitItems = await fetchBuildingRegister(molitCodes);
                molitSummary = buildMolitSummary(molitItems);
                molitStatus = molitItems.length > 0 ? "SUCCESS" : "NO_DATA";
            } else {
                molitStatus = "FAILED";
            }
        }
        
        // 4. LLM에게 모든 판단 위임 (AI Judge)
        const llmResult = await getLLMJudge(molitSummary, groupResult, baseItem);

        // LLM의 판결 결과를 UI 포맷으로 변환
        const gradeCode = llmResult.code; // RED or BLUE
        let gradeTitle;
        
        // 제목 결정 로직 (3단 분류 반영)
        if (llmResult.decision_text.includes("피난")) {
            gradeTitle = '피난용 엘리베이터 승강기 관리교육(12시간)';
        } else if (gradeCode === 'RED') {
            gradeTitle = '비상구출운전 승강기관리교육(12시간)';
        } else {
            gradeTitle = '승강기 관리교육(4시간)';
        }

        // 🚨 색상: 특수=파랑(blue), 일반=초록(green)
        const themeColor = gradeCode === 'RED' ? 'blue' : 'green'; 

        // 🚨 정제된 용도 추출 (Client 전달용)
        const rawUsage = baseItem.buldPrpos || '공동주택/기타';
        const refinedUsage = rawUsage.split('-')[0].trim(); 

        res.json({
            status: "ok",
            uiRender: {
                badgeText: llmResult.decision_text, // LLM이 결정한 뱃지 (3가지 중 하나)
                colorTheme: themeColor,
                mainTitle: gradeTitle,
                description: llmResult.reason
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
                buldPrpos: refinedUsage, // 정제된 용도 전달
                molitStatus: molitStatus
            },
            raw: { baseElevatorItem: baseItem, molitItems: molitSummary.items }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
    }
}

app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

















