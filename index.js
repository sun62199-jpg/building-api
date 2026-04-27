const express = require("express");
const path = require("path");
require("dotenv").config();

// node-fetch v3 (Render 환경 대응)
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// Render 설정에서 넣은 API 키들
const { JUSO_KEY, MOLIT_KEY, ELEVATOR_KEY } = process.env;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 1. 승강기 데이터 수집 (건물이름, 전체 주소 포함)
async function getElevatorData(elevatorNo) {
    const url = `https://apis.data.go.kr/B553664/ElevatorInformationService/getElevatorViewM?serviceKey=${ELEVATOR_KEY}&elevator_no=${elevatorNo}&_type=json`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const item = data.response?.body?.item;
        if (!item) return null;

        // 동일 건물 그룹 조회를 통해 피난용 여부와 정확한 최고층수 파악
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

// 2. 건축물대장 데이터 수집
async function getBuildingData(address) {
    // 글자 주소를 코드로 변환 (주소 API)
    const jusoUrl = `https://business.juso.go.kr/addrlink/addrLinkApi.do?confmKey=${JUSO_KEY}&keyword=${encodeURIComponent(address)}&resultType=json`;
    const resJuso = await fetch(jusoUrl);
    const dataJuso = await resJuso.json();
    const juso = dataJuso.results?.juso?.[0];
    if (!juso) return null;

    // 변환된 코드로 대장 조회
    const molitUrl = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${MOLIT_KEY}&sigunguCd=${juso.admCd.substring(0, 5)}&bjdongCd=${juso.admCd.substring(5, 10)}&bun=${juso.lnbrMnnm.padStart(4, '0')}&ji=${juso.lnbrSlno.padStart(4, '0')}&_type=json`;
    const resMolit = await fetch(molitUrl);
    const dataMolit = await resMolit.json();
    const items = dataMolit.response?.body?.items?.item || [];
    const itemList = Array.isArray(items) ? items : [items];

    const gaMokPurposes = ["문화 및 집회시설", "종교시설", "판매시설", "운수시설", "의료시설", "숙박시설"];
    let gaMokAreaSum = 0;
    let maxFloor = 0;
    let regstrGbCd = "1";

    itemList.forEach(it => {
        if (gaMokPurposes.includes(it.mainPurpsCdNm)) gaMokAreaSum += Number(it.totArea || 0);
        if (Number(it.grndFlrCnt) > maxFloor) maxFloor = Number(it.grndFlrCnt);
        regstrGbCd = it.regstrGbCd; 
    });

    return { gaMokAreaSum, maxFloor, regstrGbCd, totArea: itemList[0]?.totArea || 0 };
}

// 3. 메인 핸들러
app.post("/api/summary", async (req, res) => {
    try {
        const elevatorNo = req.body.addr;
        const evData = await getElevatorData(elevatorNo);
        if (!evData) return res.status(404).json({ error: "조회 결과 없음" });

        const blData = await getBuildingData(evData.base.address1);

        // 데이터 판정
        let multiType = "일반건축물";
        const finalMaxFloor = Math.max(evData.maxFloor, blData?.maxFloor || 0);
        const finalGaMokArea = blData?.gaMokAreaSum || 0;
        
        if (evData.hasEvac) multiType = "피난용건축물";
        else if (finalMaxFloor >= 16 || finalGaMokArea >= 5000) multiType = "다중이용건축물";

        const isCollective = blData?.regstrGbCd === "2" ? "YES" : "NO";
        const isMandatory = (finalMaxFloor >= 6 && Number(blData?.totArea || 0) >= 2000) || finalMaxFloor >= 11 ? "YES" : "NO";

        res.json({
            buldNm: evData.base.buldNm,     // 건물이름
            address: evData.base.address2,  // 전체 도로명주소
            multiType,
            isCollective,
            isMandatory,
            info: { floor: finalMaxFloor, area: finalGaMokArea }
        });
    } catch (err) {
        res.status(500).json({ error: "서버 내부 오류" });
    }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
