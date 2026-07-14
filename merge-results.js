// merge-results.js
// Gộp raw-results.json của 20 runner theo từng GIÂY,
// tính trung bình + percentile (p90, p95) của 20 máy tại đúng giây đó -> 1 dòng CSV / 1 giây.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const baseDir = "all-results";
const EXPECTED_RUNNERS = 20;

if (!fs.existsSync(baseDir)) {
  console.error(`Không tìm thấy thư mục ${baseDir}.`);
  process.exit(1);
}

const runnerDirs = fs
  .readdirSync(baseDir)
  .filter((d) => d.startsWith("k6-results-runner-"));

// Mỗi bucket = 1 giây, giữ MẢNG giá trị thô để tính percentile chính xác
// (không thể suy percentile từ tổng/trung bình).
const buckets = new Map();

const vusPerRunnerSecond = new Map(); // second -> Map(runnerId -> vus)

function getBucket(second) {
  if (!buckets.has(second)) {
    buckets.set(second, {
      durations: [],       // http_req_duration - dùng tính avg, p90, p95
      cacheHitValues: [],  // cache_hit_rate
      dbDurations: [],     // db_response_time - dùng tính avg, p95
      failedValues: [],    // http_req_failed
    });
  }
  return buckets.get(second);
}

function floorToSecond(isoTime) {
  return isoTime.slice(0, 19); // "2026-07-14T10:00:00.4231Z" -> "2026-07-14T10:00:00"
}

// Tính percentile theo cách chuẩn (nearest-rank interpolation)
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return "";
  const idx = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedArr[lower];
  const weight = idx - lower;
  return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
}

function average(arr) {
  if (arr.length === 0) return "";
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

let missingRunners = [];
let foundRunners = 0;

async function processFile(runnerId, filePath) {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (obj.type !== "Point" || !obj.data || !obj.data.time) continue;

    const second = floorToSecond(obj.data.time);
    const value = obj.data.value;
    const metric = obj.metric;

    if (metric === "http_req_duration") {
      getBucket(second).durations.push(value);
    } else if (metric === "http_req_failed") {
      getBucket(second).failedValues.push(value);
    } else if (metric === "cache_hit_rate") {
      getBucket(second).cacheHitValues.push(value);
    } else if (metric === "db_response_time") {
      getBucket(second).dbDurations.push(value);
    } else if (metric === "vus") {
      if (!vusPerRunnerSecond.has(second)) {
        vusPerRunnerSecond.set(second, new Map());
      }
      vusPerRunnerSecond.get(second).set(runnerId, value);
    }
  }
}

async function main() {
  for (const dir of runnerDirs) {
    const runnerId = dir.replace("k6-results-runner-", "");
    const filePath = path.join(baseDir, dir, "raw-results.json");

    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  Runner ${runnerId}: thiếu raw-results.json`);
      missingRunners.push(runnerId);
      continue;
    }

    await processFile(runnerId, filePath);
    foundRunners++;
    console.log(`✅ Đã xử lý runner ${runnerId}`);
  }

  for (let i = 1; i <= EXPECTED_RUNNERS; i++) {
    if (!runnerDirs.some((d) => d === `k6-results-runner-${i}`)) {
      missingRunners.push(String(i));
    }
  }

  if (buckets.size === 0) {
    console.error("Không có data point nào được ghi nhận. Dừng xử lý.");
    process.exit(1);
  }

  const sortedSeconds = Array.from(buckets.keys()).sort();

  const rows = [];
  for (const second of sortedSeconds) {
    const b = buckets.get(second);

    // Tổng vus của TẤT CẢ runner đang chạy tại giây này
    let totalVus = 0;
    if (vusPerRunnerSecond.has(second)) {
      for (const v of vusPerRunnerSecond.get(second).values()) {
        totalVus += v;
      }
    }

    // Sắp xếp mảng duration để tính percentile
    const sortedDurations = [...b.durations].sort((a, c) => a - c);
    const sortedDbDurations = [...b.dbDurations].sort((a, c) => a - c);

    rows.push({
      timestamp: second,
      total_vus_all_runners: totalVus,
      request_count: b.durations.length,
      avg_duration_ms: fmt(average(sortedDurations)),
      p90_duration_ms: fmt(percentile(sortedDurations, 90)),
      p95_duration_ms: fmt(percentile(sortedDurations, 95)),
      req_failed_rate: fmt(average(b.failedValues), 4),
      cache_hit_rate: fmt(average(b.cacheHitValues), 4),
      db_response_avg_ms: fmt(average(sortedDbDurations)),
      db_response_p95_ms: fmt(percentile(sortedDbDurations, 95)),
    });
  }

  const headers = [
    "timestamp",
    "total_vus_all_runners",
    "request_count",
    "avg_duration_ms",
    "p90_duration_ms",
    "p95_duration_ms",
    "req_failed_rate",
    "cache_hit_rate",
    "db_response_avg_ms",
    "db_response_p95_ms",
  ];

  const csvLines = [headers.join(",")];
  for (const row of rows) {
    csvLines.push(headers.map((h) => row[h] ?? "").join(","));
  }

  fs.writeFileSync("timeline-results.csv", csvLines.join("\n"));

  console.log("======================================");
  console.log(`Runner có dữ liệu: ${foundRunners}/${EXPECTED_RUNNERS}`);
  console.log(`Runner bị thiếu: ${missingRunners.length > 0 ? missingRunners.join(", ") : "Không có"}`);
  console.log(`Tổng số giây (dòng) trong timeline: ${rows.length}`);
  console.log("======================================");
  console.log("Đã ghi file timeline-results.csv");
}

function fmt(value, decimals = 2) {
  if (value === "" || value === undefined || isNaN(value)) return "";
  return Number(value).toFixed(decimals);
}

main();
