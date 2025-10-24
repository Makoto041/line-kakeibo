import axios from "axios";
import { google } from "googleapis";
import csvParser from "csv-parser";
import { Readable } from "stream";
import crypto from "crypto";

// CSV行の型定義
interface MoneyForwardCSVRow {
  日付: string;
  内容: string;
  金額: string;
  大項目?: string;
  中項目?: string;
  口座?: string;
}

// 正規化されたトランザクションの型定義
interface NormalizedTransaction {
  natural_key: string;
  date: string;
  content: string;
  amount: number;
  category: string;
  subcategory: string;
  account_name: string;
  source: string;
}

// バリデーション関数
function validateCSVRow(row: MoneyForwardCSVRow, index: number): boolean {
  const required = ["日付", "内容", "金額"];
  const missing = required.filter((field) => !row[field as keyof MoneyForwardCSVRow]);

  if (missing.length > 0) {
    console.warn(
      `⚠️ [importMoneyForward] Row ${index + 1} missing required fields: ${missing.join(", ")}`
    );
    return false;
  }

  // 日付フォーマットの検証（YYYY/MM/DD または YYYY-MM-DD）
  const datePattern = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/;
  if (!datePattern.test(row.日付)) {
    console.warn(`⚠️ [importMoneyForward] Row ${index + 1} has invalid date format: ${row.日付}`);
    return false;
  }

  // 金額の検証
  const amount = row.金額.replace(/,/g, "");
  if (isNaN(Number(amount))) {
    console.warn(`⚠️ [importMoneyForward] Row ${index + 1} has invalid amount: ${row.金額}`);
    return false;
  }

  return true;
}

export const importMoneyForward = async () => {
  try {
    console.log("🚀 [importMoneyForward] Start");

    // Google Drive認証
    // Firebase Functions では Application Default Credentials (ADC) を使用
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    // Money Forward CSVファイルを検索
    console.log("🔍 [importMoneyForward] Searching for Money Forward CSV...");
    const res = await drive.files.list({
      q: "name contains 'MoneyForward' and mimeType='text/csv'",
      orderBy: "modifiedTime desc",
      pageSize: 1,
    });

    const file = res.data.files?.[0];
    if (!file || !file.id) {
      console.log("⚠️ [importMoneyForward] No Money Forward CSV found");
      return;
    }

    console.log(`📄 [importMoneyForward] Found file: ${file.name} (ID: ${file.id})`);

    // CSVファイルをダウンロード
    const stream = await drive.files.get(
      { fileId: file.id, alt: "media" },
      { responseType: "stream" }
    );

    const rows: MoneyForwardCSVRow[] = [];

    // CSV解析
    await new Promise<void>((resolve, reject) => {
      (stream.data as Readable)
        .pipe(csvParser())
        .on("data", (row: MoneyForwardCSVRow) => rows.push(row))
        .on("end", () => {
          console.log(`📊 [importMoneyForward] Parsed ${rows.length} rows from CSV`);
          resolve();
        })
        .on("error", (error: Error) => {
          console.error("❌ [importMoneyForward] CSV parsing error:", error);
          reject(error);
        });
    });

    if (rows.length === 0) {
      console.log("⚠️ [importMoneyForward] CSV file is empty");
      return;
    }

    // データを正規化（バリデーション付き）
    const normalized: NormalizedTransaction[] = rows
      .filter((row, index) => validateCSVRow(row, index))
      .map((r) => {
        const date = r.日付.replace(/\//g, "-");
        const content = r.内容;
        const amount = Number(r.金額.replace(/,/g, ""));
        const key = crypto
          .createHash("sha256")
          .update(`${date}|${content}|${amount}`)
          .digest("hex")
          .slice(0, 16);

        return {
          natural_key: key,
          date,
          content,
          amount,
          category: r.大項目 || "",
          subcategory: r.中項目 || "",
          account_name: r.口座 || "",
          source: "Money Forward ME",
        };
      });

    console.log(
      `✅ [importMoneyForward] Validated ${normalized.length}/${rows.length} transactions`
    );

    if (normalized.length === 0) {
      console.log("⚠️ [importMoneyForward] No valid transactions to import");
      return;
    }

    // APIにPOST
    const apiBaseUrl = process.env.API_BASE_URL;
    const mfKakeiboToken = process.env.MFKAKEIBO_TOKEN;

    if (!apiBaseUrl || !mfKakeiboToken) {
      throw new Error(
        "Missing required environment variables: API_BASE_URL or MFKAKEIBO_TOKEN"
      );
    }

    const apiUrl = `${apiBaseUrl}/api/mf/import`;
    console.log(`📤 [importMoneyForward] Posting to ${apiUrl}...`);

    const response = await axios.post(
      apiUrl,
      {
        batch_id: crypto.randomUUID(),
        file_id: file.id,
        transactions: normalized,
      },
      {
        headers: {
          Authorization: `Bearer ${mfKakeiboToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30000, // 30秒タイムアウト
      }
    );

    console.log(
      `✅ [importMoneyForward] Successfully imported ${normalized.length} records from ${file.name}`
    );
    console.log(`📊 [importMoneyForward] API response status: ${response.status}`);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("❌ [importMoneyForward] API request failed:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
      });
    } else {
      console.error("❌ [importMoneyForward] Unexpected error:", error);
    }
    throw error; // Cloud Functionsに失敗を通知
  }
};
