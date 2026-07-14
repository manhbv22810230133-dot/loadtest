// merge-results.js
// Gộp kết quả summary.json từ 20 runner k6, tính trung bình, xuất CSV.

const fs = require("fs");
const path = require("path");

const baseDir = "all-results";
const EXPECTED_RUNNERS = 20; // tổng số runner trong matrix, dùng để báo cáo thiếu

if (!fs.existsSync(baseDir)) {
  console.error(`Không tìm thấy thư mục ${baseDir}. Không có artifact nào được tải về.`);
  process.exit(1);
}

const runnerDirs = fs
  .readdirSync(baseDir)
  .filter((d) => d.startsWith("k6-results-runner-"))
  .sort((a, b) => {
    const numA = Number(a.replace("k6-results-runner-", ""));
    const numB = Number(b.replace("k6-results-runner-", ""));
    return numA - numB;
  });

const rows = [];
const missingRunners = [];
const foundRunnerIds = [];

for (const dir of runnerDirs) {
  const runnerId = dir.replace("k6-results-runner-", "");
  const filePath = path.join(baseDir, dir, "summary.json");

  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  Runner ${runnerId}: thiếu summary.json`);
    missingRunners.push(runnerId);
    continue;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.log(`⚠️  Runner ${runnerId}: summary.json bị lỗi JSON (${e.message})`);
    missingRunners.push(runnerId);
    continue;
  }

  const m = data.metrics || {};

  rows.push({
    runner: runnerId,
    vus_max: m.vus_max?.values?.max ?? "",
    requests: m.http_reqs?.values?.count ?? "",
    req_failed_rate: m.http_req_failed?.values?.rate ?? "",
    duration_avg: m.http_req_duration?.values?.avg ?? "",
    duration_p50: m.http_req_duration?.values?.["p(50)"] ?? "",
    duration_p90: m.http_req_duration?.values?.["p(90)"] ?? "",
    duration_p95: m.http_req_duration?.values?.["p(95)"] ?? "",
    duration_p99: m.http_req_duration?.values?.["p(99)"] ?? "",
    cache_hit_rate: m.cache_hit_rate?.values?.rate ?? "",
    cache_response_avg: m.cache_response_time?.values?.avg ?? "",
    db_response_avg: m.db_response_time?.values?.avg ?? "",
    db_response_p95: m.db_response_time?.values?.["p(95)"] ?? "",
  });

  foundRunnerIds.push(runnerId);
}

// Kiểm tra runner nào bị thiếu artifact hoàn toàn (không có cả folder)
const foundDirIds = runnerDirs.map((d) => d.replace("k6-results-runner-", ""));
for (let i = 1; i <= EXPECTED_RUNNERS; i++) {
  const id = String(i);
  if (!foundDirIds.includes(id)) {
    console.log(`⚠️  Runner ${id}: không có artifact nào được upload (job có thể đã fail trước bước upload)`);
    missingRunners.push(id);
  }
}

if (rows.length === 0) {
  console.error("Không có runner nào có dữ liệu hợp lệ. Dừng xử lý.");
  process.exit(1);
}

// Các cột số cần tính trung bình
const numericCols = [
  "vus_max",
  "requests",
  "req_failed_rate",
  "duration_avg",
  "duration_p50",
  "duration_p90",
  "duration_p95",
  "duration_p99",
  "cache_hit_rate",
  "cache_response_avg",
  "db_response_avg",
  "db_response_p95",
];

// Tính trung bình cộng — chỉ trên các runner có dữ liệu hợp lệ
const avgRow = { runner: `AVERAGE (n=${rows.length}/${EXPECTED_RUNNERS})` };
for (const col of numericCols) {
  const values = rows.map((r) => Number(r[col])).filter((v) => !isNaN(v));
  const avg =
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : "";
  avgRow[col] = avg === "" ? "" : avg.toFixed(2);
}

// Tổng số request thực tế (không phải trung bình, mà là tổng tải toàn hệ thống)
const totalRow = { runner: "TOTAL" };
totalRow.requests = rows.reduce((sum, r) => sum + (Number(r.requests) || 0), 0);

// Ghép dữ liệu: 20 dòng runner + dòng trung bình + dòng tổng
const finalRows = [...rows, avgRow, totalRow];

// Xuất CSV
const headers = ["runner", ...numericCols];
const csvLines = [headers.join(",")];
for (const row of finalRows) {
  const line = headers.map((h) => row[h] ?? "").join(",");
  csvLines.push(line);
}

fs.writeFileSync("merged-results.csv", csvLines.join("\n"));

console.log("======================================");
console.log(`Tổng runner mong đợi: ${EXPECTED_RUNNERS}`);
console.log(`Runner có dữ liệu hợp lệ: ${rows.length}`);
console.log(`Runner bị thiếu: ${missingRunners.length > 0 ? missingRunners.join(", ") : "Không có"}`);
console.log("Trung bình cộng (avg):", avgRow);
console.log("======================================");
console.log("Đã ghi file merged-results.csv");
