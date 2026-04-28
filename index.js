const express = require("express");
const path = require("path");
require("dotenv").config();

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

const { JUSO_KEY, MOLIT_KEY, ELEVATOR_KEY } = process.env;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 1. 승강기 데이터 수집 (기존 유지)
async function getElevatorData(elevatorNo) {
    const url = `https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorViewM?serviceKey=${ELEVATOR_KEY}&elevator_no=${elevatorNo}&_type=json`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const item = data.response?.body?.item;
        if (!item) return null;

        // 같은 건물 내 모든 승강기 확인 (피난용 및 최고층 파악용)
        const listUrl = `https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorListM?serviceKey=${ELEVATOR_KEY}&sido=${encodeURIComponent(item.address1.split(' ')[0])}&sigungu=${encodeURIComponent(item.address1.split(' ')[1])}&buld_nm=${encodeURIComponent(item.buldNm)}&_type=json`;
        const listRes = await fetch(listUrl);
        const listData = await listRes.json();
        const items = listData.response?.body?.items?.item || [item];
        const itemList = Array.isArray(items) ? items : [items];

        return {
            base: item,
            hasEvac: itemList.some(i => i.elvtrKindNm && i.elvtrKindNm.includes('피난')),
            maxFloor: Math.max(...itemList.map(i => Number(i.divGroundFloorCnt) || 0))
        };
    } catch (e) { return null; }
}

// 2. 건축물대장 데이터 수집 (필지 내 모든 건물 통합 조회)
async function getBuildingData(address) {
    if (!address) return null;
    const jusoUrl = `https://business.juso.go.kr/addrlink/addrLinkApi.do?confmKey=${JUSO_KEY}&keyword=${encodeURIComponent(address)}&resultType=json`;
    const resJuso = await fetch(jusoUrl);
    const dataJuso = await resJuso.json();
    const juso = dataJuso.results?.juso?.[0];
    if (!juso) return null;

    // numOfRows=100을 추가하여 지번 내 모든 동을 가져옴
    const molitUrl = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${MOLIT_KEY}&sigunguCd=${juso.admCd.substring(0, 5)}&bjdongCd=${juso.admCd.substring(5, 10)}&bun=${juso.lnbrMnnm.padStart(4, '0')}&ji=${juso.lnbrSlno.padStart(4, '0')}&_type=json&numOfRows=100`;
    const resMolit = await fetch(molitUrl);
    const dataMolit = await resMolit.json();
    const items = dataMolit.response?.body?.items?.item || [];
    const itemList = Array.isArray(items) ? items : [items];

    const targetKeywords = ["문화및집회", "종교", "판매", "운수", "의료", "숙박"];
    
    let gaMokAreaSum = 0; // 6개 용도 합계
    let complexMaxFloor = 0; // 단지 내 최고층
    let isCollective = "NO";
    let representativeTotArea = 0; // 법정필수용 (가장 큰 동 기준)

    itemList.forEach(it => {
        const mainPurpose = it.mainPurpsCdNm || "";
        const etcPurpose = it.etcPurps || "";
        const floor = Number(it.grndFlrCnt || 0);
        const area = Number(it.totArea || 0);

        // 1. 단지 내 최고층 갱신
        if (floor > complexMaxFloor) complexMaxFloor = floor;
        
        // 2. 가장 큰 동 면적 (법정필수 판단용)
        if (area > representativeTotArea) representativeTotArea = area;

        // 3. 다중이용 가목(6개 용도) 면적 합산
        const isTargetUsage = targetKeywords.some(kw => mainPurpose.includes(kw) || etcPurpose.includes(kw));
        if (isTargetUsage) {
            gaMokAreaSum += area;
        }

        // 4. 집합건물 여부
        if (it.regstrGbCd === "2") isCollective = "YES";
    });

    return { 
        gaMokAreaSum, 
        maxFloor: complexMaxFloor, 
        isCollective, 
        representativeTotArea 
    };
}

app.post("/api/summary", async (req, res) => {
    try {
        const elevatorNo = req.body.addr;
        const evData = await getElevatorData(elevatorNo);
        if (!evData) return res.status(404).json({ error: "조회 결과 없음" });

        const blData = await getBuildingData(evData.base.address1);

        // --- 정밀 판정 로직 ---
        let multiType = "일반건축물";
        const finalMaxFloor = Math.max(evData.maxFloor, blData?.maxFloor || 0);
        const finalGaMokArea = blData?.gaMokAreaSum || 0;
        
        // 1순위: 피난용 승강기 여부
        if (evData.hasEvac) {
            multiType = "피난용건축물";
        } 
        // 2순위: 다중이용 나목 (용도 상관없이 16층 이상)
        else if (finalMaxFloor >= 16) {
            multiType = "다중이용(나목-16층이상)";
        } 
        // 3순위: 다중이용 가목 (6개 용도 합계 5,000㎡ 이상)
        else if (finalGaMokArea >= 5000) {
            multiType = "다중이용(가목-5천㎡이상)";
        }

        // 법정필수 판정 (최고 층수 11층 이상 혹은 6층이상&2000㎡)
        const isMandatory = (finalMaxFloor >= 11 || (finalMaxFloor >= 6 && (blData?.representativeTotArea || 0) >= 2000)) ? "YES" : "NO";

        // 주소 출력 최적화: 지번 (도로명)
        const combinedAddress = `${evData.base.address2 || ''} (${evData.base.address1 || ''})`.trim();

        res.json({
            buldNm: evData.base.buldNm || '이름 없는 건물',
            address: combinedAddress,
            multiType,
            isCollective: blData?.isCollective || "NO",
            isMandatory,
            info: { 
                floor: finalMaxFloor, 
                area: Math.round(finalGaMokArea) 
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "서버 내부 오류" });
    }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
