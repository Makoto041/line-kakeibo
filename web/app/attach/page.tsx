"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage, ensureFirebaseInitialized } from "../../lib/firebase";
import dayjs from "dayjs";

// Suspense boundary for useSearchParams（ビルドエラー防止）
export default function AttachPage() {
  return (
    <Suspense fallback={<AttachPageLoading />}>
      <AttachPageContent />
    </Suspense>
  );
}

function AttachPageLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">読み込み中...</p>
      </div>
    </div>
  );
}

interface ExpenseSummary {
  description: string;
  amount: number;
  date: string;
  category?: string;
  receiptUrl?: string;
}

function isSafeImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["blob:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function AttachPageContent() {
  const searchParams = useSearchParams();
  const expenseId = searchParams.get("expenseId");

  const [expense, setExpense] = useState<ExpenseSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 支出データの取得
  useEffect(() => {
    const fetchExpense = async () => {
      if (!expenseId) {
        setError("支出IDが指定されていません。LINEの通知メッセージのボタンからアクセスしてください。");
        setLoading(false);
        return;
      }

      try {
        ensureFirebaseInitialized();
        if (!db) {
          setError("データベースに接続できませんでした。時間をおいて再度お試しください。");
          setLoading(false);
          return;
        }

        const snap = await getDoc(doc(db, "expenses", expenseId));
        if (!snap.exists()) {
          setError("指定された支出が見つかりませんでした。");
          setLoading(false);
          return;
        }

        const data = snap.data();
        setExpense({
          description: data.description || "（名称なし）",
          amount: data.amount || 0,
          date: data.date || "",
          category: data.category,
          receiptUrl: data.receiptUrl,
        });
      } catch (err) {
        console.error("Failed to fetch expense:", err);
        setError("支出データの取得に失敗しました。");
      } finally {
        setLoading(false);
      }
    };

    fetchExpense();
  }, [expenseId]);

  // ファイル選択時の処理
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("画像ファイルを選択してください。");
      return;
    }

    setError(null);
    setSelectedFile(file);

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setPreviewDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  // アップロード処理
  const handleUpload = async () => {
    if (!selectedFile || !expenseId) return;

    setUploading(true);
    setError(null);

    try {
      ensureFirebaseInitialized();
      if (!storage || !db) {
        throw new Error("Firebaseの初期化に失敗しました。");
      }

      // パス: receipts/{expenseId}/{timestamp}_{filename}
      const timestamp = Date.now();
      const safeName = selectedFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageRef = ref(storage, `receipts/${expenseId}/${timestamp}_${safeName}`);

      await uploadBytes(storageRef, selectedFile, {
        contentType: selectedFile.type,
      });
      const downloadUrl = await getDownloadURL(storageRef);

      // 支出ドキュメントに receiptUrl を保存
      await updateDoc(doc(db, "expenses", expenseId), {
        receiptUrl: downloadUrl,
        updatedAt: new Date(),
      });

      setExpense((prev) => (prev ? { ...prev, receiptUrl: downloadUrl } : prev));
      setUploadDone(true);
      setReplacing(false);
      setSelectedFile(null);
      setPreviewDataUrl(null);
    } catch (err) {
      console.error("Upload failed:", err);
      setError(
        "アップロードに失敗しました。" +
          (err instanceof Error ? ` (${err.message})` : "")
      );
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return <AttachPageLoading />;
  }

  const hasReceipt = !!expense?.receiptUrl;
  const showUploadForm = !hasReceipt || replacing;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <div className="bg-white shadow-sm">
        <div className="max-w-lg mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-gray-900">📎 レシート添付</h1>
        </div>
      </div>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 text-sm">{error}</p>
          </div>
        )}

        {expense && (
          <>
            {/* 支出概要 */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-medium text-gray-500 mb-3">対象の支出</h2>
              <p className="text-lg font-semibold text-gray-900 break-words">
                {expense.description}
              </p>
              <p className="text-2xl font-bold text-red-600 mt-1">
                ¥{expense.amount.toLocaleString()}
              </p>
              <p className="text-sm text-gray-600 mt-1">
                {expense.date
                  ? dayjs(expense.date).format("YYYY年M月D日")
                  : "日付不明"}
                {expense.category ? ` ・ ${expense.category}` : ""}
              </p>
            </div>

            {/* アップロード完了メッセージ */}
            {uploadDone && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <p className="text-green-800 text-sm font-medium">
                  ✅ レシートを添付しました！このページは閉じて構いません。
                </p>
              </div>
            )}

            {/* 既存レシートのプレビュー */}
            {hasReceipt && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                <h2 className="text-sm font-medium text-gray-500 mb-3">
                  添付済みのレシート
                </h2>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {expense.receiptUrl && isSafeImageUrl(expense.receiptUrl) && (
                  <img
                    src={expense.receiptUrl}
                    alt="添付済みレシート"
                    className="w-full rounded-lg border border-gray-200"
                  />
                )}
                {!replacing && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplacing(true);
                      setUploadDone(false);
                    }}
                    className="mt-4 w-full bg-gray-500 text-white px-4 py-3 rounded-lg text-sm font-medium hover:bg-gray-600 transition-colors"
                  >
                    🔄 レシートを差し替える
                  </button>
                )}
              </div>
            )}

            {/* アップロードフォーム */}
            {showUploadForm && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 space-y-4">
                <h2 className="text-sm font-medium text-gray-500">
                  {hasReceipt ? "新しいレシートを選択" : "レシート画像を選択"}
                </h2>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-400 hover:bg-blue-50 transition-colors"
                >
                  <span className="text-3xl block mb-2">📷</span>
                  <span className="text-sm text-gray-600">
                    タップして撮影 / 画像を選択
                  </span>
                </button>

                {previewDataUrl && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-2">
                      プレビュー
                    </h3>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={previewDataUrl}
                      alt="選択した画像のプレビュー"
                      className="w-full rounded-lg border border-gray-200"
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={!selectedFile || uploading}
                  className={`w-full px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                    !selectedFile || uploading
                      ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  {uploading ? "アップロード中..." : "⬆️ アップロードする"}
                </button>

                {replacing && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplacing(false);
                      setSelectedFile(null);
                      setPreviewDataUrl(null);
                    }}
                    className="w-full bg-white text-gray-600 border border-gray-300 px-4 py-3 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
                  >
                    キャンセル
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
