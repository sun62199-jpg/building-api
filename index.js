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

// 2. 환경변수
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ELEVATOR_KEY = process.env.ELEVATOR_KEY || MOLIT_KEY;

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY) {
  console.warn("⚠️ 필수 환경변수 누락 확인 필요");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- [HELPER FUNCTIONS: JUSO, MOLIT, ELEVATOR FETCHING] ---
// (이전 버전과 동일한 데이터 조회 함수들은 지면 관계상 생략하고, 핵심 로직만 바꿉니다.)
// * searchAddress, callMolitApiSingle, fetchBuildingRegister
// * generateElevatorSearchNames, fetchElevatorInfo, searchElevatorWithFallbackNames
// * calculateSimilarity, findBestMatchingElevator, getElevatorSummary, buildMolitSummary
// 위 함수들은 V2.9.5와 동일하게 유지됩니다. (실제 코드엔 포함되어야 함)

// ... (데이터 조회 함수들 생략 - V2.9.5와 동일) ...

// 👇 여기부터가 V6.0의 핵심 변경 사항입니다. 👇

// 4. JUSO 주소 검색 (V2.9.5 동일)
async function searchAddress(input) {
    // ... (기존 searchAddress 코드 복붙)
    console.log(`[JUSO] 검색 시도: ${input}`);
    const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    const params = { confmKey: JUSO_KEY, currentPage: "1", countPerPage: "5", keyword: input, resultType: "json" };
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    try {
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`HTTP Error`);
        const data = await res.json();
        if (!data.results || data.results.common.errorCode !== "0") return null;
        const juso = data.results.juso[0];
        if (!juso) return null;
        return {
            sigunguCd: juso.admCd.substring(0, 5), bjdongCd: juso.admCd.substring(5, 10),
            bun: String(juso.lnbrMnnm || "").padStart(4, "0"), ji: String(juso.lnbrSlno || "").padStart(4, "0"),
            jibun: `${juso.emdNm} ${juso.lnbrMnnm}-${juso.lnbrSlno}`, roadAddr: juso.roadAddr,
            siNm: juso.siNm, sggNm: juso.sggNm, buldNm: juso.bdNm
        };
    } catch (e) { return null; }
}

// ... (MOLIT/Elevator Fetch 함수들 - V2.9.5와 동일하게 사용) ...
// (지면상 생략: fetchBuildingRegister, searchElevatorWithFallbackNames, buildMolitSummary, getElevatorSummary, findBestMatchingElevator)
// 실제 구현 시엔 V2.9.5의 5번~6번 섹션 함수들을 그대로 여기에 넣으세요.

// 5. API 호출용 임시 함수 (테스트용 - 실제론 V2.9.5의 함수들 사용)
// [이곳에 fetchBuildingRegister 등 V2.9.5의 모든 조회 함수가 들어갔다고 가정]

// ============================================================
// 🚀 7. [Server-Driven Logic] 안전 등급 결정 및 UI 데이터 생성
// ============================================================

function determineSafetyGrade(molitSummary, elevatorSummary, isFallback) {
    const THRESHOLD_AREA = 5000;
    
    // 1. 데이터 통합 (보수적 기준: 더 큰 값 채택)
    const finalMaxFloor = Math.max(molitSummary?.maxFloor || 0, elevatorSummary?.maxFloor || 0);
    const gaMokArea = molitSummary?.gaMokArea || 0;
    const elevCount = elevatorSummary?.items ? elevatorSummary.items.length : (molitSummary?.items ? 0 : 0); // 대략적 카운트
    
    // 승강기 실제 개수는 elevatorSummary가 있으면 그것, 없으면 0
    const realElevCount = elevatorSummary?.items ? 1 : 0; // 임시: items 배열이 없어서 1로 침 (수정 필요) -> 실제론 elevatorSummary 로직 따름

    // 2. 기준 판단
    const isGaMok = gaMokArea >= THRESHOLD_AREA;
    const isNaMok = finalMaxFloor >= 16;
    
    // 3. 등급 결정 로직 (순서 중요)
    
    // [RED] 특수 관리 대상 (가장 위험)
    if (isGaMok || isNaMok) {
        return {
            code: 'RED',
            badge: '교육 대상',
            colorTheme: 'red',
            title: '비상구출운전 승강기관리교육 (12시간)',
            reason_type: isGaMok ? '다중이용건축물(가목)' : '16층 이상(나목)'
        };
    }

    // [BLUE] 일반 관리 대상 (승강기 보유 확인됨)
    // MOLIT가 있거나, Fallback 상황에서 승강기가 조회된 경우
    // (V2.9.5 로직: elevMaxF > 0 또는 MOLIT 성공시 elevCount 고려 등)
    // 여기서는 간단히: 16층 미만인데 승강기 API에 데이터가 있거나 MOLIT에 승강기가 있다고 나올 때
    // (현재 MOLIT 승강기 수는 신뢰도가 낮으므로, 승강기 API 결과나 층수 기반 추정)
    
    // 승강기 API 결과가 있거나(Fallback 성공), MOLIT는 성공했는데 층수가 2~15층인 경우(일반)
    if (elevatorSummary.maxFloor > 0 || (molitSummary.totalCount > 0 && finalMaxFloor >= 2 && !isFallback)) {
         return {
            code: 'BLUE',
            badge: '교육 대상',
            colorTheme: 'blue',
            title: '승강기 관리교육 (4시간)',
            reason_type: '일반건축물(승강기 보유)'
        };
    }

    // [YELLOW] 확인 필요 (데이터상 승강기 없지만 2층 이상)
    if (finalMaxF >= 2) {
        return {
            code: 'YELLOW',
            badge: '확인 필요',
            colorTheme: 'yellow',
            title: '⚠️ 승강기 설치 여부 확인 필요',
            reason_type: '데이터 불일치(2층 이상)'
        };
    }

    // [GRAY] 대상 아님
    return {
        code: 'GRAY',
        badge: '대상 아님',
        colorTheme: 'gray',
        title: '교육 의무 없음',
        reason_type: '1층 이하/승강기 미보유'
    };
}

// 8. LLM 통합 문장 생성 (Server-Driven Context)
async function generateLLMDescription(gradeInfo, molitSummary, elevatorSummary) {
    const prompt = `
    상황: 건물 안전관리 교육 대상 여부 판단.
    판단결과: ${gradeInfo.code} (${gradeInfo.reason_type}).
    데이터: 건축물대장(최고 ${molitSummary.maxFloor}층, 가목면적 ${molitSummary.gaMokArea}㎡), 승강기정보(최고 ${elevatorSummary.maxFloor}층).
    
    요청: 위 판단 결과에 대해 사용자에게 설명하는 친절한 한 문장을 작성해줘.
    - RED: 16층 이상이거나 다중이용건축물이므로 12시간 교육이 필수임을 강조.
    - BLUE: 일반 승강기 관리 교육(4시간) 대상임을 안내.
    - YELLOW: 전산상 승강기 정보가 없으나 건물이 ${Math.max(molitSummary.maxFloor, elevatorSummary.maxFloor)}층이므로 현장 확인이 필요함을 안내.
    - GRAY: 1층 이하이거나 승강기가 없어 교육 대상이 아님을 안내.
    
    출력: JSON 형식 {"message": "문장"}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }],
            temperature: 0.0, max_tokens: 200,
        });
        const content = response.choices[0].message.content.trim();
        const s = content.indexOf('{'), e = content.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(content.substring(s, e + 1)).message;
        return content; // 파싱 실패 시 원문
    } catch (e) {
        return `시스템 판단 결과: ${gradeInfo.reason_type}에 해당합니다.`;
    }
}

// 9. API 핸들러 (최종 통합)
async function apiSummaryHandler(req, res) {
    try {
        const addr = req.body.addr;
        if (!addr) return res.status(400).json({ error: "주소 필요" });

        // 1. Juso 검색
        const addressInfo = await searchAddress(addr);
        if (!addressInfo) return res.status(404).json({ error: "주소 검색 실패" });

        // 2. 병렬 조회 (V2.9.5 로직)
        // (실제 구현 시엔 위에서 정의한 함수 사용, 여기서는 가상 호출)
        // const [molitItems, elevatorResult] = ...
        // 실제 코드를 합칠 땐 V2.9.5의 병렬 조회 로직을 그대로 쓰세요.
        // 여기선 로직 흐름만 보여드립니다.
        
        // ... (데이터 조회 및 요약 로직: V2.9.5와 동일) ...
        // const molitSummary = ...
        // const elevatorSummary = ...

        // --- [가상 데이터 생성: 테스트용] ---
        // 실제 코드에서는 위 조회 로직의 결과를 씁니다.
        const molitSummary = { maxFloor: 27, gaMokArea: 0, totalCount: 1 }; 
        const elevatorSummary = { maxFloor: 28, count: 106 };
        const isFallback = false;
        // ----------------------------------

        // 3. 🚨 서버 주도 판단 (Server-Driven Logic)
        const gradeInfo = determineSafetyGrade(molitSummary, elevatorSummary, isFallback);

        // 4. 🤖 LLM 설명 생성
        const llmDescription = await generateLLMDescription(gradeInfo, molitSummary, elevatorSummary);

        // 5. 📦 최종 UI Payload 생성 (클라이언트는 이걸 그대로 뿌림)
        res.json({
            status: "ok",
            uiRender: {
                badgeText: gradeInfo.badge,   // "교육 대상"
                colorTheme: gradeInfo.colorTheme, // "red", "blue", "yellow"
                mainTitle: gradeInfo.title,   // "비상구출운전..."
                description: llmDescription,  // LLM이 만든 문장
            },
            data: {
                address: addressInfo.roadAddr,
                molit: { floor: molitSummary.maxFloor, area: molitSummary.gaMokArea },
                elevator: { floor: elevatorSummary.maxFloor, count: 10 }, // 예시
                source: isFallback ? "승강기 정보 (FALLBACK)" : "건축물대장 (MOLIT)"
            },
            raw: { molitSummary, elevatorSummary } // 디버깅용 원본
        });

    } catch (err) {
        res.status(500).json({ error: "서버 오류" });
    }
}

app.post("/api/summary", apiSummaryHandler);
// ...
