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
const JUSO_KEY = process.env.JUSO_KEY; // 역변환용으로 유지
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
// 4. Primary Search: By Elevator Number (New)
// ---------------------------------------------------------
// 🚨 NOTE: 이 함수가 기존 searchAddress(input) 역할을 대체합니다.
async function getElevatorBaseInfo(elevatorNo) {
    const url = new URL(`https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorDetailInfo`);
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
        
        // Item 구조는 user가 제공한 상세 스키마를 따름 (body.item)
        return data.body?.item || null; 
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
    
    // 🚨 핵심: 동일 건물 관리번호(buldMgtNo1+2) 또는 건물명으로만 검색하여 정확한 통합 목록을 만듭니다.
    const params = {
        serviceKey: ELEVATOR_KEY, pageNo: "1", numOfRows: "100", _type: "json",
        sido: baseItem.address1.split(' ')[0], // 임시 Sido 추출
        sigungu: baseItem.sigunguCd,
        buld_nm: baseItem.buldNm, 
    };

    try {
        const res = await fetch(url.toString());
        const data = await res.json();
        if (data.response?.header?.resultCode !== "00") return { count: 0, items: [], hasEvacElevator: false };
        
        const rawItems = data.response?.body?.items?.item;
        const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
        
        // 피난용 승강기 여부 체크
        const hasEvacElevator = items.some(i => i.elvtrKindNm && i.elvtrKindNm.includes('피난'));

        // 유틸리티 함수 findBestMatchingElevator를 대체하는 임시 로직
        const totalCount = items.length;
        
        return { 
            count: totalCount, 
            items: items, 
            hasEvacElevator: hasEvacElevator 
        };
    } catch (e) {
        return { count: 0, items: [], hasEvacElevator: false };
    }
}

// 5-C. MOLIT functions (using converted codes)

async function fetchBuildingRegister(molitCodes) { // Takes the output of reverseAddressToMolitCode
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`);
  // Note: Assuming a fixed ji offset of 0 for simplicity, based on Juso's direct output
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

// 5-D. Utility functions (simplified/kept from V10.0 for future use)

function getElevatorSummary(elevatorItems) {
    if (!elevatorItems?.length) return { maxFloor: 0 };
    const maxFloor = Math.max(...elevatorItems.map(i => Number(i.divGroundFloorCnt) || 0));
    return { maxFloor };
}

// ---------------------------------------------------------
// 6. MOLIT Summary (No change to summary calculation)
// ---------------------------------------------------------
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
function determineSafetyGrade(molitSummary, elevatorSummary, isFallback) {
    const finalMaxFloor = Math.max(molitSummary?.maxFloor || 0, elevatorSummary?.maxFloor || 0);
    const gaMokArea = molitSummary?.gaMokArea || 0;
    
    const isGaMok = gaMokArea >= 5000;
    const isNaMok = finalMaxFloor >= 16;

    // [RED] 다중이용건축물 (12시간)
    if (isGaMok || isNaMok) {
        return {
            code: 'RED', badge: '교육 대상', colorTheme: 'blue',
            title: '비상구출운전 승강기관리교육(12시간)',
            reason_type: isGaMok ? '다중이용건축물(가목)' : '16층 이상(나목)',
            desc_prefix: isGaMok ? `해당 건물은 ${molitSummary.gaMokType || '공동주택/기타'}이고 연면적이 ${gaMokArea.toFixed(2)}㎡이므로 "가"목 항목에 해당합니다.` : `해당 건물은 일반건축물 용도이지만 최고층 ${finalMaxFloor}층이므로 "나"목 항목에 해당합니다.`
        };
    }

    // 🚨 [BLUE] 일반건축물 (4시간) - YELLOW/GRAY 통합 🚨
    if (molitSummary.totalCount > 0 || elevatorSummary.maxFloor > 0) { 
        return {
            code: 'BLUE', badge: '일반 건축물', colorTheme: 'green',
            title: '승강기 관리교육(4시간)', // 통일된 교육명
            reason_type: '일반건축물',
            desc_prefix: '해당 건물은 일반건축물로 해당합니다.' 
        };
    }

    // [GRAY] 대상 아님 (데이터가 아예 없을 때만 404로 빠짐)
    return {
        code: 'BLUE', badge: '일반 건축물', colorTheme: 'green',
        title: '승강기 관리교육(4시간)', // 일반 건축물 타이틀 사용
        reason_type: '일반건축물', 
        desc_prefix: '해당 건물은 일반건축물로 해당합니다.'
    };
}

// 8. LLM 설명 생성 (2차: AI 판단 및 설명)

async function generateLLMDescription(gradeInfo, molitSummary, elevatorSummary) {
    const finalFloor = Math.max(molitSummary.maxFloor || 0, elevatorSummary.maxFloor || 0);
    const area = molitSummary.gaMokArea || 0;
    const usage = molitSummary.gaMokType || '공동주택/기타';
    const isGaMok = area >= 5000;
    const isNaMok = finalFloor >= 16;

    // 최종 판정 미리 계산 (LLM에게 줄 정답)
    const finalDecision = isGaMok || isNaMok ? "예" : "아니오";
    const templateText = gradeInfo.desc_prefix; // Node.js가 이미 최종 문구를 확정

    const prompt = `
    [역할] 건축법 전문가이자 최종 문구를 작성하는 AI입니다. (귀하의 유일한 임무는 논리 구조를 엄격히 따르는 것입니다.)

    
    [핵심 데이터]
    1. 최고 층수: ${finalFloor}층
    2. 가목 면적: ${area.toFixed(2)}㎡
    3. 가목 용도: ${usage}

    [지시사항]
    1. **판단:** 'decision' 필드에 '${finalDecision}'를 확정하세요.
    2. **문구 생성:** 아래 [결정된 법적 템플릿]의 내용을 확인하고 'reason' 필드에 삽입하세요. **문구 구조를 절대 변경하지 마시오.**

    [결정된 법적 템플릿]
    "${templateText}"

    [출력 형식]
    JSON Only: {"decision": "${finalDecision}", "reason": "템플릿 문구"}
    `;



    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }],
            temperature: 0.0, max_tokens: 350,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(content.substring(s, e + 1));
      
        // 파싱 실패 시, 시스템의 기본 설명 반환
        return { decision: finalDecision, reason: gradeInfo.desc_prefix + " (AI 파싱 오류로 원문 복구 실패)" };
    } catch (e) {
        return { decision: finalDecision, reason: gradeInfo.desc_prefix + " (AI 분석 중 오류 발생)" };
    }
}

// 9. API 핸들러
async function apiSummaryHandler(req, res) {
    try {
        const addr = req.body.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });

        const addressInfo = await searchAddress(addr);
        if (!addressInfo) return res.status(404).json({ error: "주소 검색 실패" });

        const [molitItems, elevatorResult] = await Promise.all([
            fetchBuildingRegister(addressInfo).catch(() => []),
            searchElevatorWithFallbackNames(addressInfo).catch(() => ({ count: 0, items: [] }))
        ]);

        const molitSummary = buildMolitSummary(molitItems);
        const bestElevator = findBestMatchingElevator(addressInfo.buldNm, elevatorResult.items);
        const elevatorSummary = getElevatorSummary(bestElevator ? [bestElevator] : []);

        const isFallback = (molitSummary.totalCount === 0) || (molitSummary.maxFloor === 0 && molitSummary.gaMokArea === 0);
        
        if (isFallback && elevatorResult.count === 0) {
             return res.status(404).json({ error: "건축물 정보 없음", detail: "데이터 조회 실패" });
        }

        const gradeInfo = determineSafetyGrade(molitSummary, elevatorSummary, isFallback);
        const llmResult = await generateLLMDescription(gradeInfo, molitSummary, elevatorSummary);

        res.json({
            status: "ok",
            uiRender: {
                badgeText: gradeInfo.badge,
                colorTheme: gradeInfo.colorTheme,
                mainTitle: gradeInfo.title,
                description: llmResult.reason
            },
            addressInfo: { roadAddr: addressInfo.roadAddr, jibun: addressInfo.jibun },
            analysis: {
                ruleBased: gradeInfo.code,
                llmFinalDecision: llmResult.decision, 
                llmReason: llmResult.reason
            },
            data: {
                address: addressInfo.roadAddr,
                molit: { floor: molitSummary.maxFloor, area: molitSummary.gaMokArea },
                elevator: { floor: elevatorSummary.maxFloor, count: elevatorResult.count },
                source: isFallback ? "승강기 정보 (FALLBACK)" : "건축물대장 (MOLIT)"
            },
            summaryDetails: {
                총건물수: molitSummary.totalCount,
                최고지상층수: molitSummary.maxFloor,
                가목_연면적_합계: molitSummary.gaMokArea,
                가목_대표_용도: molitSummary.gaMokType,
                elevatorCount: elevatorResult.count,
                elevatorMaxFloor: elevatorSummary.maxFloor,
                elevatorSource: bestElevator ? '승강기 정보 있음' : '승강기 정보 없음',
                daJungList: molitSummary.items
            },
            raw: { molit: molitSummary.items, elevator: bestElevator }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류", detail: err.toString() });
    }
}

app.post("/api/summary", apiSummaryHandler);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

