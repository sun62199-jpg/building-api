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
        if (!res.ok) throw new Error(`Elevator Detail API HTTP Error ${res.status}`);
        const data = await res.json();
        
        if (data.response?.header?.resultCode !== "00") return null;
        
        return data.response?.body?.item || null; 
    } catch (e) {
        console.error(`[ELEVATOR SEARCH ERROR] Failed for No ${elevatorNo}: ${e.message}`);
        return null;
    }
}

// ---------------------------------------------------------
// 5. Data Acquisition & Consolidation
// ---------------------------------------------------------

// 5-A. Juso API used for Reverse Geocoding (FIXED)
async function reverseAddressToMolitCode(addrString) {
    if (!addrString) return null;

    // 🚨 FIX: 괄호와 그 안의 내용 제거, 앞뒤 공백 제거 (예: "경기도 .. (덕계동)" -> "경기도 ..")
    const cleanAddr = addrString.replace(/\(.*\)/g, '').trim();
    
    const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    const params = {
        confmKey: JUSO_KEY, 
        currentPage: "1", 
        countPerPage: "1", 
        keyword: cleanAddr, // 정제된 주소 사용
        resultType: "json",
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        
        if (!data.results || data.results.common.errorCode !== "0") return null;
        if (!data.results.juso || data.results.juso.length === 0) return null;

        const juso = data.results.juso[0];
        
        return {
            sigunguCd: juso.admCd.substring(0, 5),
            bjdongCd: juso.admCd.substring(5, 10),
            bun: String(juso.lnbrMnnm || "").padStart(4, "0"), 
            ji: String(juso.lnbrSlno || "").padStart(4, "0"),
            roadAddr: juso.roadAddr,
            jibunAddr: juso.jibunAddr
        };
    } catch (e) {
        console.error(`[JUSO REVERSE ERROR]: ${e.message}`);
        return null;
    }
}

// 5-D. Utility functions
function getElevatorSummary(elevatorItems) {
    if (!elevatorItems?.length) return { maxFloor: 0 };
    const maxFloor = Math.max(...elevatorItems.map(i => Number(i.divGroundFloorCnt) || 0));
    return { maxFloor };
}

// 5-B. Grouping all Elevators
async function findAndGroupAllElevators(baseItem) {
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM`);
    
    // 주소 파싱 (Sido, Sigungu) - 정확도를 위해 address1 사용
    const addrParts = baseItem.address1.split(' ');
    const sido = addrParts[0]; 
    const sigungu = addrParts[1]; // 예: 양주시
    
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

        // 동일 건물 필터링 (관리번호 기준)
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

// 5-C. MOLIT functions
async function fetchBuildingRegister(molitCodes) { 
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`);
  const params = { 
    serviceKey: MOLIT_KEY, 
    sigunguCd: molitCodes.sigunguCd, 
    bjdongCd: molitCodes.bjdongCd, 
    platGbCd: "0", 
    bun: molitCodes.bun, 
    ji: molitCodes.ji, 
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

// 6. MOLIT Summary (필터링 제거 유지)
function buildMolitSummary(items) { 
    const filtered = items.filter(it => {
        const totArea = Number(it.totArea) || 0;
        const grndFlrCnt = Number(it.grndFlrCnt) || 0;
        if ((totArea === 0 || grndFlrCnt === 0) && grndFlrCnt < 16) return false;
        return true; 
    });
    
    const maxFloor = filtered.length ? Math.max(...filtered.map(it => Number(it.grndFlrCnt) || 0)) : 0;
    const daJungList = filtered.filter(it => ["공동주택", "제2종근린생활시설", "문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));
    const gaMokArea = daJungList.filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm)).reduce((sum, it) => sum + Number(it.totArea), 0);
    const gaMokType = daJungList.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));

    return { totalCount: filtered.length, maxFloor, gaMokArea, gaMokType: gaMokType ? gaMokType.mainPurpsCdNm : null, items: daJungList };
}

// 7. 안전 등급 결정 (1차: Node.js)
function determineSafetyGrade(molitSummary, elevatorSummary, baseItem, isFallback) {
    const finalMaxFloor = Math.max(molitSummary?.maxFloor || 0, elevatorSummary?.maxFloor || 0);
    const gaMokArea = molitSummary?.gaMokArea || 0;
    
    const isGaMok = gaMokArea >= 5000;
    const isNaMok = finalMaxFloor >= 16;
    const hasEvacElevator = elevatorSummary.hasEvacElevator;

    const usageText = baseItem.buldPrpos || '공동주택/기타';

    // 1. 피난용 (최우선) -> RED
    if (hasEvacElevator) {
        return {
            code: 'RED', badge: '교육 대상', colorTheme: 'blue',
            title: '피난용 엘리베이터 승강기 관리교육(12시간)',
            reason_type: '피난용 엘리베이터 설치',
            desc_prefix: `해당 건물은 피난용 엘리베이터가 설치되어 있어 특수 관리 대상입니다.`
        };
    }
    
    // 2. 특수 관리 (RED)
    if (isGaMok || isNaMok) {
        let descText;
        let reasonType;

        if (isGaMok) {
            reasonType = '다중이용건축물(가목)';
            descText = `해당 건물은 ${molitSummary.gaMokType || usageText}이고 연면적이 ${gaMokArea.toFixed(2)}㎡이므로 "가"목 항목에 해당합니다.`;
        } else {
            reasonType = '16층 이상(나목)';
            descText = `해당 건물은 ${usageText} 용도이지만 최고층 ${finalMaxFloor}층이므로 연면적 관계없이 "나"목 항목에 해당합니다.`;
        }
        
        return {
            code: 'RED', badge: '교육 대상', colorTheme: 'blue',
            title: '비상구출운전 승강기관리교육(12시간)',
            reason_type: reasonType,
            desc_prefix: descText
        };
    }

    // 3. 일반 관리 (BLUE)
    return {
        code: 'BLUE', badge: '일반 건축물', colorTheme: 'green',
        title: '승강기 관리교육(4시간)',
        reason_type: '일반건축물',
        desc_prefix: '해당 건물은 일반건축물로 해당합니다.' 
    };
}

// 8. LLM 설명 생성 (2차: AI 판단 및 설명)
async function generateLLMDescription(gradeInfo, molitSummary, elevatorSummary, baseItem) {
    const finalFloor = Math.max(molitSummary.maxFloor || 0, elevatorSummary.maxFloor || 0);
    const area = molitSummary.gaMokArea || 0;
    const usage = baseItem.buldPrpos || '공동주택/기타';
    
    const isGaMok = area >= 5000;
    const isNaMok = finalFloor >= 16;

    const finalDecision = (isGaMok || isNaMok || elevatorSummary.hasEvacElevator) ? "예" : "아니오";
    const templateText = gradeInfo.desc_prefix; 

    const prompt = `
    [역할] 건축법 전문가 AI
    [지시] 아래 [결정된 문구]를 그대로 사용하여 사용자에게 결과를 안내하세요.
    
    [결정된 문구]
    "${templateText}"
    
    [출력] JSON Only: {"decision": "${finalDecision}", "reason": "결정된 문구"}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }],
            temperature: 0.0, max_tokens: 350,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(content.substring(s, e + 1));
        return { decision: finalDecision, reason: gradeInfo.desc_prefix };
    } catch (e) {
        return { decision: finalDecision, reason: gradeInfo.desc_prefix };
    }
}

// 9. API 핸들러 (V11.8 FIX)
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

        // 3. MOLIT 조회 (피난용X, 16층 미만이면 무조건 조회 시도)
        if (!hasEvacElevator && finalMaxFloor < 16) {
            
            // 🚨 FIX: address2가 아닌 address1(메인주소)을 사용하여 검색
            const molitCodes = await reverseAddressToMolitCode(baseItem.address1);
            
            if (molitCodes) {
                const molitItems = await fetchBuildingRegister(molitCodes);
                molitSummary = buildMolitSummary(molitItems);
                molitStatus = molitItems.length > 0 ? "SUCCESS" : "NO_DATA";
            } else {
                molitStatus = "FAILED"; // 주소 변환 실패
            }
        }
        
        // 4. 등급 결정
        const gradeInfo = determineSafetyGrade(molitSummary, groupResult, baseItem, false); 
        
        // 5. LLM 생성
        const llmResult = await generateLLMDescription(gradeInfo, molitSummary, groupResult, baseItem);

        res.json({
            status: "ok",
            uiRender: {
                badgeText: gradeInfo.badge,
                colorTheme: gradeInfo.colorTheme,
                mainTitle: gradeInfo.title,
                description: llmResult.reason
            },
            addressInfo: { roadAddr: baseItem.address2, jibun: baseItem.address1 },
            analysis: {
                ruleBased: gradeInfo.code,
                llmFinalDecision: llmResult.decision, 
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
                buldPrpos: baseItem.buldPrpos,
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
