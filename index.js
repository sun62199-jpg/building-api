// 1. 기본 세팅
const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3(CommonJS에서 ESM 사용)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// OpenAI CommonJS 방식
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 환경변수 확인
const JUSO_KEY = process.env.JUSO_KEY;
const MOLIT_KEY = process.env.MOLIT_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;

if (!JUSO_KEY || !MOLIT_KEY || !OPENAI_KEY) {
  console.warn(
    "⚠️ 환경변수가 부족합니다. JUSO_KEY, MOLIT_KEY, OPENAI_KEY 필요"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// 3. 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 4. JUSO 주소 검색 (없음 시 null 반환으로 수정)
async function searchAddress(input) {
  console.log(`[JUSO DEBUG] 검색을 시도한 주소: ${input}`);
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
    throw new Error(
      `주소 검색 실패: ${data.results?.common?.errorMessage || "알 수 없는 오류"}`
    );
  }

  const juso = data.results.juso[0];
  if (!juso) {
        console.warn(`[JUSO WARN] 검색 결과 없음: ${input}`);
        return null; // ⬅️ 오류를 던지지 않고 null 반환
    }

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
  const url = new URL(
    "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo"
  );
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

  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) throw new Error(`건축물대장 API 오류: HTTP ${res.status}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("건축물대장 JSON 파싱 실패 → " + text);
  }

  const header = data.response?.header;
  if (!header || header.resultCode !== "00")
    throw new Error(
      `건축물대장 조회 실패: ${header?.resultMsg || "알 수 없는 오류"}`
    );

  return data.response?.body?.items?.item || [];
}

// 6. 한글화 & 요약 (Node.js 계산을 위해 데이터 구조 변경)
function buildSummary(items) {
  const 다중이용건물 = items.filter(
    (it) =>
      [
        "공동주택",
        "제2종근린생활시설",
        "문화 및 집회시설",
        "종교시설",
        "판매시설",
        "운수시설",
        "의료시설",
        "숙박시설",
      ].includes(it.mainPurpsCdNm) ||
      (typeof it.etcPurps === "string" && it.etcPurps.includes("근린생활시설"))
  );
    
    // 1. 최고층 수치 계산
    const 최고지상층수 = 다중이용건물.length 
        ? Math.max(...다중이용건물.map(it => Number(it.grndFlrCnt) || 0)) 
        : 0;

    // 2. 가목 해당 용도의 연면적 합계 계산
    const 가목_연면적_합계 = 다중이용건물
        .filter(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm))
        .reduce((sum, item) => sum + Number(item.totArea), 0);
    
    // 3. 가목 해당 용도 (문장 생성을 위한 대표 용도 1개)
    const 가목_용도 = 다중이용건물.find(it => ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"].includes(it.mainPurpsCdNm));
    
  return {
    총건물수: items.length,
    다중이용건물수: 다중이용건물.length,
    최고지상층수: 최고지상층수,
    가목_연면적_합계: 가목_연면적_합계, 
    가목_대표_용도: 가목_용도 ? 가목_용도.mainPurpsCdNm : null, // 대표 용도 문자열
    다중이용건물: 다중이용건물.map((it) => ({
      용도: it.mainPurpsCdNm,
      지상층: Number(it.grndFlrCnt),
      연면적: Number(it.totArea)
    })),
  };
}

// 7. 룰 기반 판단 (GPT 문장 생성을 위한 최종 근거 데이터 포함)
function isMultiUseBuilding(summary) {
    const multiUseAreaThreshold = 5000;
    const 최고지상층수 = summary.최고지상층수 || 0;
    const 가목_합계 = summary.가목_연면적_합계 || 0;
    
    // 1. 나목 해당 여부 (가목 용도 외 모든 건물 16층 이상)
    const 나목_해당 = 최고지상층수 >= 16;
    
    // 2. 가목 해당 여부
    const 가목_해당 = 가목_합계 >= multiUseAreaThreshold;
    
    // GPT가 문장을 만들도록 최종 근거 데이터 생성
    let GPT_판단_근거 = {};

    if (가목_해당) {
        // 가목 해당 시 나목 무시 (가목이 더 엄격한 기준)
        GPT_판단_근거 = {
            결과: "예",
            판단_기준: "가목",
            가목_용도: summary.가목_대표_용도,
            가목_연면적: 가목_합계.toFixed(2)
        };
    } else if (나목_해당) {
        // 나목 해당 시 (가목에 해당하지 않으므로)
        GPT_판단_근거 = {
            결과: "예",
            판단_기준: "나목",
            최고층: 최고지상층수
        };
    } else {
        // 둘 다 해당 없음
        GPT_판단_근거 = {
            결과: "아니오",
            판단_기준: "없음"
        };
    }

    const 결과 = 가목_해당 || 나목_해당;

    return {
        다중이용건축물: 결과,
        판단이유: 결과 
            ? `가목: ${가목_해당 ? '해당' : '없음'}, 나목: ${나목_해당 ? '해당' : '없음'}`
            : "가목·나목 해당 없음",
        // 🚨 GPT가 문장만 생성하도록 최종 판단 근거 데이터 전달
        GPT_근거: GPT_판단_근거
    };
}

// 8. LLM 판단 (계산된 결과로 문장만 생성하는 역할로 축소)
async function llmJudgment(ruleResult) { // ruleResult 객체를 인수로 받음
    const { GPT_근거 } = ruleResult;
    
    const prompt = `
주어진 JSON 데이터는 건축물의 다중이용건축물 여부를 서버가 최종 판단한 결과입니다.
당신의 역할은 이 결과를 바탕으로 정해진 형식의 '판단근거' 문장을 생성하는 것입니다.
계산을 수행하지 말고, 오직 주어진 GPT_근거 데이터만을 사용하여 문장을 생성해야 합니다.

**[GPT_근거 데이터]**
${JSON.stringify(GPT_근거, null, 2)}

**[판단 근거 작성 규칙]**
1.  '다중이용건축물' 키 값은 **GPT_근거.결과** 값을 그대로 사용한다.
2.  판단 근거는 아래 형식 중 **하나만을 사용**하여 단정적인 문장 하나로 구성한다.

    * **나목 해당 시 형식:** "이 건물은 ${GPT_근거.최고층}층 이므로 다중이용건축물에 해당됩니다."
    * **가목 해당 시 형식:** "이 건물은 다중이용건축물 기준 중 **${GPT_근거.가목_용도}(굵은글씨)**로 해당되고, 연면적이 ${GPT_근거.가목_연면적}㎡이기 때문에 다중이용건축물에 해당됩니다."
    * **해당 없을 시 형식:** "이 건물은 다중이용건축물 기준(가목, 나목)에 해당되지 않습니다."

출력 예시:
{ "다중이용건축물": "예", "판단근거": "이 건물은 29층 이므로 다중이용건축물에 해당됩니다." }
`;

    // 🚨 LLM 호출 
    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1, 
    });
    const content = response.choices[0].message.content;

    return JSON.parse(content);
}

// 9. 카카오톡 스킬용 라우트 (룰 + LLM) - 단일 응답 구조로 최종 복원
async function kakaoSummaryHandler(req, res) {
  try {
    let addr;
    
    // 주소 추출 로직
    if (req.method === "GET") {
      addr = req.query.addr;
    } else if (req.method === "POST") {
      if (req.body && req.body.action && req.body.action.params) {
        addr = req.body.action.params.addr; 
      }
      if (!addr && req.body.addr) {
        addr = req.body.addr;
      }
    }

    if (!addr) {
      return res.status(400).json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: "주소가 필요합니다. 다시 입력해 주세요." } }],
        },
      });
    }
    
    // 🚨 유효성 필터링 강화
    const cleanAddr = (addr || '').trim(); 
    if (cleanAddr.length < 2 || cleanAddr.includes('{') || cleanAddr.includes('}')) {
        console.error(`[INVALID ADDR] 유효하지 않은 주소 형식 감지: ${addr}`);
        return res.json({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: "⚠️ 주소 형식이 올바르지 않습니다. 정확한 주소를 입력해 주세요." } }],
            },
        });
    }

    // 1. 필수 정보 조회 (Juso, Molit)
    const addressInfo = await searchAddress(cleanAddr);
    
    // 🚨 주소 검색 결과가 null인 경우 (없는 주소인 경우) 처리
    if (!addressInfo) {
        return res.json({ // ⬅️ HTTP 200 OK 응답
            version: "2.0",
            template: {
                outputs: [{
                    simpleText: {
                        text: `⚠️ 죄송합니다. "${cleanAddr}"에 대한 건축물 정보를 찾을 수 없습니다.\n\n주소를 다시 확인해 주세요.`,
                    }
                }]
            }
        });
    }
    
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items); // 수정된 summary 구조 사용

    // 2. 룰 기반 판단 (서버에서 최종 판단 근거를 모두 계산)
    const ruleResult = isMultiUseBuilding(summary);
    
    // 3. LLM 판단 호출 (계산된 근거로 문장만 생성)
    const llmResult = await llmJudgment(ruleResult);
    
    // 4. 🎨 응답 텍스트 구성: 문단 간격 두 줄 적용 (최종 깔끔한 텍스트 출력)
    const responseText = 
        `[건축물 안전 분석 리포트]\n` +
        `조회 주소: ${addressInfo.roadAddr} (${addressInfo.jibun})\n\n\n` +
        
        `법규 기반 최종 판단\n` +
        `다중이용건축물 여부 = ${ruleResult.다중이용건축물 ? 'YES' : 'NO'}\n` +
        `주요 판단 근거 = ${ruleResult.판단이유}\n\n\n` +
        
        `AI 전문 분석 (GPT)\n` +
        `AI 최종 판단 = ${llmResult.다중이용건축물}\n` +
        `분석 근거 요약 = ${llmResult.판단근거}`;


    // 카카오 스킬용 JSON
    const responseJSON = {
      version: "2.0",
      template: {
        outputs: [
          {
            simpleText: {
              text: responseText
            }
          }
        ]
      }
    };

    res.json(responseJSON);

  } catch (err) {
    console.error("FATAL ERROR IN KAKAO SUMMARY HANDLER (단일 응답):", err);
    res.status(500).json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: `조회 실패: ${String(err)}` } }
        ]
      }
    });
  }
}


// 10. 기존 summary 유지
app.get("/summary", async (req, res) => {
  try {
    const addr = req.query.addr;
    if (!addr) return res.status(400).json({ error: "주소 필요" });
    const addressInfo = await searchAddress(addr);
    
    if (!addressInfo) { return res.status(400).json({ error: "주소 검색 결과 없음" }); } // null 체크 추가
    
    const items = await fetchBuildingRegister(addressInfo);
    const summary = buildSummary(items);
    const multiUse = isMultiUseBuilding(summary);

    const 최고지상층수 = summary.최고지상층수 || 0; // 변경된 summary 구조 반영

    const GA_TYPES = [
      "문화 및 집회시설",
      "종교시설",
      "판매시설",
      "운수시설",
      "의료시설",
      "숙박시설",
    ];
    const 가항목 = {};
    const multiUseAreaThreshold = 5000;
    GA_TYPES.forEach((type) => {
      const 대상 = summary.다중이용건물.filter(
        (it) => it.용도 === type && it.연면적 >= multiUseAreaThreshold
      );
      가항목[type] = 대상.length > 0 ? "해당" : "해당없음";
    });

    res.json({
      주소: `${addressInfo.roadAddr} (${addressInfo.jibun})`,
      다중이용건축물: multiUse.다중이용건축물 ? "예" : "아니오",
      판단근거: { 가: 가항목, 나: { 최고지상층수 } },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "조회 실패", detail: String(err) });
  }
});

// GET/POST 모두 단일 핸들러로 연결
app.get("/kakao-summary", kakaoSummaryHandler);
app.post("/kakao-summary", kakaoSummaryHandler);

// 루트
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

// 서버 시작
app.listen(PORT, () =>
  console.log(`서버 실행 중 ▶ http://localhost:${PORT}`)
);
