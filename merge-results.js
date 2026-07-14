// merge-results.js
// Gộp raw-results.json của 20 runner theo từng GIÂY (dấu thời gian thực),
// tính trung bình các chỉ số của 20 máy tại đúng giây đó -> 1 dòng CSV / 1 giây.

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

// Bucket theo giây: key = "2026-07-14T10:00:00" (đã cắt phần mili giây)
// Mỗi bucket gộp dữ liệu từ TẤT CẢ runner rơi vào đúng giây đó
const buckets = new Map();

// Track vus riêng theo runner, vì metric "vus" là Gauge, báo cáo định kỳ
// (không phải mỗi request), cần lấy giá trị gần nhất của mỗi runner tại
// mỗi giây rồi CỘNG DỒN giữa các runner (vì 20 runner chạy song song
// = tổng số user thật đang tải tại giây đó).
const vusPerRunnerSecond = new Map(); // second -> Map(runnerId -> vus)

function getBucket(second) {
  if (!buckets.has(second)) {
    buckets.set(second, {
      durationSum: 0,
      durationCount: 0,
      cacheHitSum: 0,
      cacheHitCount: 0,
      dbDurationSum: 0,
      dbDurationCount: 0,
      failedSum: 0,
      failedCount: 0,
    });
  }
  return buckets.get(second);
}

function floorToSecond(isoTime) {
  // "2026-07-14T10:00:00.4231Z" -> "2026-07-14T10:00:00"
  return isoTime.slice(0, 19);
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
      continue; // bỏ qua dòng lỗi
    }
    if (obj.type !== "Point" || !obj.data || !obj.data.time) continue;

    const second = floorToSecond(obj.data.time);
    const value = obj.data.value;
    const metric = obj.metric;

    if (metric === "http_req_duration") {
      const b = getBucket(second);
      b.durationSum += value;
      b.durationCount += 1;
    } else if (metric === "http_req_failed") {
      const b = getBucket(second);
      b.failedSum += value;
      b.failedCount += 1;
    } else if (metric === "cache_hit_rate") {
      const b = getBucket(second);
      b.cacheHitSum += value;
      b.cacheHitCount += 1;
    } else if (metric === "db_response_time") {
      const b = getBucket(second);
      b.dbDurationSum += value;
      b.dbDurationCount += 1;
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

  // Sắp xếp các giây theo thứ tự thời gian
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

    rows.push({
      timestamp: second,
      total_vus_all_runners: totalVus,
      request_count: b.durationCount,
      avg_duration_ms: b.durationCount > 0 ? (b.durationSum / b.durationCount).toFixed(2) : "",
      req_failed_rate: b.failedCount > 0 ? (b.failedSum / b.failedCount).toFixed(4) : "",
      cache_hit_rate: b.cacheHitCount > 0 ? (b.cacheHitSum / b.cacheHitCount).toFixed(4) : "",
      db_response_avg_ms: b.dbDurationCount > 0 ? (b.dbDurationSum / b.dbDurationCount).toFixed(2) : "",
    });
  }

  const headers = [
    "timestamp",
    "total_vus_all_runners",
    "request_count",
    "avg_duration_ms",
    "req_failed_rate",
    "cache_hit_rate",
    "db_response_avg_ms",
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

main();
