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
// 4. Primary Search: By Elevator Number (V11.2 - JSON Path Fix)
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
        
        // 🚨 FIX 1: resultCode 체크 시 'response' 객체 경로 포함
        if (data.response?.header?.resultCode !== "00") {
             // 데이터가 없거나 서비스 오류일 경우 (예: RESULT CODE 03, NO DATA)
             return null;
        }
        
        // 🚨 FIX 2: Item 추출 시 'response' 객체 경로 포함
        return data.response?.body?.item || null; 
    } catch (e) {
        console.error(`[ELEVATOR SEARCH ERROR] Failed for No ${elevatorNo}: ${e.message}`);
        return null;
    }
}

// ---------------------------------------------------------
// 5. Data Acquisition & Consolidation
// ---------------------------------------------------------

// 5-A. Juso API used for Reverse Geocoding (Gets codes for MOLIT)
async function reverseAddressToMolitCode(roadAddr, jibunAddr) {
    const searchAddr = roadAddr || jibunAddr;
    if (!searchAddr) return null;
    
    const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    const params = {
        confmKey: JUSO_KEY, currentPage: "1", countPerPage: "1", keyword: searchAddr, resultType: "json",
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        if (!data.results || data.results.common.errorCode !== "0") return null;

        const juso = data.results.juso[0];
        if (!juso) return null;
        
        const admCd = juso.admCd;
        return {
            sigunguCd: admCd.substring(0, 5),
            bjdongCd: admCd.substring(5, 10),
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

// 5-B. Grouping all Elevators in the same building
async function findAndGroupAllElevators(baseItem) {
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM`);
    
    const params = {
        serviceKey: ELEVATOR_KEY, pageNo: "1", numOfRows: "100", _type: "json",
        sido: baseItem.address1.split(' ')[0], // Crude extraction of Sido from address1
        sigungu: baseItem.sigunguCd,
        buld_nm: baseItem.buldNm, 
    };

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        if (data.response?.header?.resultCode !== "00") return { count: 0, items: [], hasEvacElevator: false, maxFloor: 0 };
        
        const rawItems = data.response?.body?.items?.item;
        const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
        
        // 피난용 승강기 여부 체크
        const hasEvacElevator = items.some(i => i.elvtrKindNm && i.elvtrKindNm.includes('피난'));

        // 최고층 확인
        const maxFloorInGroup = getElevatorSummary(items).maxFloor;

        return { 
            count: items.length, 
            items: items, 
            hasEvacElevator: hasEvacElevator,
            maxFloor: maxFloorInGroup
        };
    } catch (e) {
        return { count: 0, items: [], hasEvacElevator: false, maxFloor: 0 };
    }
}

// 5-C. MOLIT functions (using converted codes)

async function fetchBuildingRegister(molitCodes) { // Takes the output of reverseAddressToMolitCode
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

// 5-D. Utility functions (V11.2 수정)
function getElevatorSummary(elevatorItems) {
    if (!elevatorItems?.length) return { maxFloor: 0 };
    // 🚨 FIX: divGroundFloorCnt 필드를 사용하여 최고층을 계산 (새 스키마 반영)
    const maxFloor = Math.max(...elevatorItems.map(i => Number(i.divGroundFloorCnt) || 0));
    return { maxFloor };
}


// 7. 안전 등급 결정 (1차: Node.js) - V11.2 수정
// 🚨 baseItem을 받아 건물 용도 정보를 직접 참조합니다.
function determineSafetyGrade(molitSummary, elevatorSummary, baseItem, isFallback) {
    const finalMaxFloor = elevatorSummary.maxFloor || 0;
    const gaMokArea = molitSummary?.gaMokArea || 0;
    const isGaMok = gaMokArea >= 5000;
    const isNaMok = finalMaxFloor >= 16;
    
    // 🚨 FIX: baseItem에서 건물 용도를 추출 (불일치 시 '공동주택/기타'로 폴백)
    const usageText = baseItem.buldPrpos || '공동주택/기타';

    // 🚨 1. 피난용 엘리베이터 최우선 체크 (이전 V11.0 로직 유지)
    if (elevatorSummary.hasEvacElevator) {
        return {
            code: 'RED', badge: '교육 대상', colorTheme: 'blue',
            title: '피난용 엘리베이터 승강기 관리교육(12시간)',
            reason_type: '피난용 엘리베이터 설치',
            desc_prefix: `해당 건물은 피난용 엘리베이터가 설치되어 있어 특수 관리 대상입니다.`
        };
    }
    
    // [RED] 특수 관리 (12시간) - Na-mok or Ga-mok
    if (isGaMok || isNaMok) {
        let descText;
        let reasonType;

        if (isGaMok) {
            reasonType = '다중이용건축물(가목)';
            descText = `해당 건물은 ${usageText}이고 연면적이 ${gaMokArea.toFixed(2)}㎡이므로 "가"목 항목에 해당합니다.`;
        } else {
            reasonType = '16층 이상(나목)';
            // 🚨 FIX: 나목 템플릿에 용도와 층수 명시
            descText = `해당 건물은 ${usageText} 용도이지만 최고층 ${finalMaxFloor}층이므로 연면적 관계없이 "나"목 항목에 해당합니다.`;
        }
        
        return {
            code: 'RED', badge: '교육 대상', colorTheme: 'blue',
            title: '비상구출운전 승강기관리교육(12시간)',
            reason_type: reasonType,
            desc_prefix: descText
        };
    }

    // [BLUE] 일반 관리 (4시간) - 모든 16층 미만 건물 포함
    if (molitSummary.totalCount > 0 || elevatorSummary.maxFloor > 0) { 
        return {
            code: 'BLUE', badge: '일반 건축물', colorTheme: 'green',
            title: '승강기 관리교육(4시간)',
            reason_type: '일반건축물',
            desc_prefix: '해당 건물은 일반건축물로 해당합니다.' 
        };
    }

    // [GRAY] 대상 아님 (최종 캐치-올)
    return {
        code: 'BLUE', badge: '일반 건축물', colorTheme: 'gray', 
        title: '승강기 관리교육(4시간)',
        reason_type: '일반건축물', 
        desc_prefix: '해당 건물은 일반건축물로 해당합니다.'
    };
}


// 8. LLM 설명 생성 (2차: AI 판단 및 설명) - V11.2 수정
// 🚨 baseItem을 받아 LLM 프롬프트에 정확한 용도를 제공
async function generateLLMDescription(gradeInfo, molitSummary, elevatorSummary, baseItem) {
    const finalFloor = elevatorSummary.maxFloor || 0;
    const area = molitSummary.gaMokArea || 0;
    const usage = baseItem.buldPrpos || '공동주택/기타'; // 🚨 FIX: baseItem의 용도를 사용
    
    const isGaMok = area >= 5000;
    const isNaMok = finalFloor >= 16;
    const finalDecision = isGaMok || isNaMok ? "예" : "아니오";

    const prompt = `
    [역할] 건축법 전문가이자 최종 문구를 작성하는 AI입니다. (귀하의 유일한 임무는 아래 논리 구조를 엄격히 따르는 것입니다.)
    
    [핵심 데이터]
    1. 최고 층수: ${finalFloor}층
    2. 가목 면적: ${area.toFixed(2)}㎡
    3. 가목 용도: ${usage}
    
    [판단 기준 및 출력 템플릿]
    1. **가목 템플릿 (면적 ≥ 5000㎡):** '해당 건물은 ${usage}이고 연면적이 ${area.toFixed(2)}㎡이므로 "가"목 항목에 해당합니다.'
    2. **나목 템플릿 (층수 ≥ 16F):** '해당 건물은 ${usage} 용도이지만 최고층 ${finalFloor}층이므로 "나"목 항목에 해당합니다.'
    3. **일반 템플릿 (둘 다 미달):** '해당 건물은 일반건축물로 해당합니다.'

    [지시사항]
    1. **판단:** 가목 또는 나목에 해당하면 '예', 아니면 '아니오'로 판단하세요.
    2. **문구 생성:** 위 판단 결과에 따라 [출력 템플릿] 중 **가장 높은 순위에 해당하는 템플릿 문구 하나**를 선택하여 'reason' 필드에 삽입하세요. **문구 구조를 절대 변경하지 마시오.**
    3. **출력:** JSON Only: {"decision": "${finalDecision}", "reason": "선택된 문구"}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }],
            temperature: 0.0, max_tokens: 350,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(content.substring(s, e + 1));
        
        return { decision: finalDecision, reason: gradeInfo.desc_prefix + " (AI 파싱 오류로 원문 복구 실패)" };
    } catch (e) {
        return { decision: gradeInfo.code === 'RED' ? '예' : '아니오', reason: gradeInfo.desc_prefix + " (AI 분석 중 오류 발생)" };
    }
}

// 9. API 핸들러 - V11.2 수정
async function apiSummaryHandler(req, res) {
    try {
        const input = req.body.addr; // 승강기 번호 입력
        if (!input) return res.status(400).json({ error: "승강기 번호가 필요합니다." });

        // 1. 1차 정보 획득 (승강기 번호로 직접 조회)
        const baseItem = await getElevatorBaseInfo(input); 
        if (!baseItem) return res.status(404).json({ error: "승강기 번호 조회 실패", detail: "일치하는 승강기 정보가 없습니다." });
        
        // 2. 동일 건물 승강기 그룹화 및 최고층 획득
        const groupResult = await findAndGroupAllElevators(baseItem);
        
        const finalMaxFloor = groupResult.maxFloor;
        const hasEvacElevator = groupResult.hasEvacElevator;
        
        let molitCodes = null;
        let molitSummary = { totalCount: 0, maxFloor: 0, gaMokArea: 0, items: [] };

        // 3. 🚨 MOLIT 조회 필요성 판단 및 실행 🚨
        if (!hasEvacElevator && finalMaxFloor < 16) {
            
            // 승강기 정보의 주소로 JUSO 역변환 (MOLIT 코드 획득)
            molitCodes = await reverseAddressToMolitCode(baseItem.address2, baseItem.address1);
            
            if (molitCodes) {
                const molitItems = await fetchBuildingRegister(molitCodes);
                molitSummary = buildMolitSummary(molitItems);
            }
        }
        
        // 4. 최종 등급 판단 (Node.js)
        const gradeInfo = determineSafetyGrade(molitSummary, groupResult, baseItem, false); 
        
        // 5. LLM 판단 및 설명
        // 🚨 FIX: baseItem을 LLM 함수로 전달
        const llmResult = await generateLLMDescription(gradeInfo, molitSummary, groupResult, baseItem);

        res.json({
            status: "ok",
            uiRender: {
                badgeText: gradeInfo.badge,
                colorTheme: gradeInfo.colorTheme,
                mainTitle: gradeInfo.title,
                description: llmResult.reason
            },
            // 🚨 FIX: addressInfo는 baseItem의 주소를 사용
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
            },
            raw: { baseElevatorItem: baseItem, molitItems: molitSummary.items }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
    }
}
