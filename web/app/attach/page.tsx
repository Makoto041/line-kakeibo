"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage, ensureFirebaseInitialized } from "../../lib/firebase";
import dayjs from "dayjs";

export default function AttachPage() {
  return (
    <Suspense fallback={<AttachPageLoading />}>
      <AttachPageContent />
    </Suspense>
  );
}

function AttachPageLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="liquid-bg" aria-hidden="true" />
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
        <p className="text-sm text-gray-400">読み込み中...</p>
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

  const handleUpload = async () => {
    if (!selectedFile || !expenseId) return;

    setUploading(true);
    setError(null);

    try {
      ensureFirebaseInitialized();
      if (!storage || !db) {
        throw new Error("Firebaseの初期化に失敗しました。");
      }

      const timestamp = Date.now();
      const safeName = selectedFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageRef = ref(storage, `receipts/${expenseId}/${timestamp}_${safeName}`);

      await uploadBytes(storageRef, selectedFile, {
        contentType: selectedFile.type,
      });
      const downloadUrl = await getDownloadURL(storageRef);

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
    <div className="min-h-screen">
      <div className="liquid-bg" aria-hidden="true" />

      {/* Glass header */}
      <header className="sticky top-0 z-40">
        <div className="glass-strong border-x-0 border-t-0 rounded-none">
          <div className="flex items-center h-12 px-4 max-w-lg mx-auto">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
              </svg>
              <h1 className="text-base font-bold text-gray-900">レシート添付</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-5">
        {/* Error message */}
        {error && (
          <div className="glass-card rounded-2xl px-4 py-3 text-sm font-medium text-center text-red-700 border-red-200/50">
            {error}
          </div>
        )}

        {expense && (
          <>
            {/* Expense summary - hero card */}
            <div className="glass-hero rounded-3xl p-5">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">対象の支出</p>
              <p className="text-base font-semibold text-gray-900 break-words">{expense.description}</p>
              <p className="text-3xl font-bold text-gray-900 mt-1 tabular-nums tracking-tight">
                ¥{expense.amount.toLocaleString()}
              </p>
              <div className="flex items-center gap-2 mt-3">
                <span className="glass-inset rounded-full px-3 py-1 text-xs text-gray-500">
                  {expense.date
                    ? dayjs(expense.date).format("YYYY年M月D日")
                    : "日付不明"}
                </span>
                {expense.category && (
                  <span className="glass-accent rounded-full px-3 py-1 text-xs text-emerald-700">
                    {expense.category}
                  </span>
                )}
              </div>
            </div>

            {/* Upload success message */}
            {uploadDone && (
              <div className="glass-accent rounded-2xl px-4 py-3 text-sm font-medium text-center text-emerald-700">
                レシートを添付しました！このページは閉じて構いません。
              </div>
            )}

            {/* Existing receipt preview */}
            {hasReceipt && (
              <div className="glass-card rounded-3xl overflow-hidden">
                <div className="px-5 pt-4 pb-3">
                  <p className="text-xs font-medium text-gray-500">添付済みのレシート</p>
                </div>
                <div className="px-5 pb-5">
                  {expense.receiptUrl && isSafeImageUrl(expense.receiptUrl) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={expense.receiptUrl}
                      alt="添付済みレシート"
                      className="w-full rounded-2xl"
                    />
                  )}
                  {!replacing && (
                    <button
                      type="button"
                      onClick={() => {
                        setReplacing(true);
                        setUploadDone(false);
                      }}
                      className="pressable mt-4 w-full bg-gray-500/80 text-white py-3 rounded-full text-sm font-medium hover:bg-gray-600/80 transition-colors"
                    >
                      レシートを差し替える
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Upload form */}
            {showUploadForm && (
              <div className="glass-card rounded-3xl overflow-hidden">
                <div className="px-5 pt-4 pb-3">
                  <p className="text-xs font-medium text-gray-500">
                    {hasReceipt ? "新しいレシートを選択" : "レシート画像を選択"}
                  </p>
                </div>

                <div className="px-5 pb-5 space-y-4">
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
                    className="pressable w-full glass-inset border-2 border-dashed border-white/60 rounded-2xl p-6 text-center hover:bg-white/50 transition-colors"
                  >
                    <div className="glass-accent w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3">
                      <svg className="w-7 h-7 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-600 font-medium">タップして撮影 / 画像を選択</p>
                  </button>

                  {previewDataUrl && (
                    <div className="glass-inset rounded-2xl p-3">
                      <p className="text-xs font-medium text-gray-500 mb-2">プレビュー</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={previewDataUrl}
                        alt="選択した画像のプレビュー"
                        className="w-full rounded-xl"
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleUpload}
                    disabled={!selectedFile || uploading}
                    className="pressable w-full bg-emerald-600/90 text-white py-3 rounded-full text-sm font-medium shadow-sm hover:bg-emerald-600 disabled:opacity-50 transition-colors"
                  >
                    {uploading ? "アップロード中..." : "アップロードする"}
                  </button>

                  {replacing && (
                    <button
                      type="button"
                      onClick={() => {
                        setReplacing(false);
                        setSelectedFile(null);
                        setPreviewDataUrl(null);
                      }}
                      className="pressable w-full glass-card py-3 rounded-full text-sm font-medium text-gray-600 hover:bg-white/60 transition-colors"
                    >
                      キャンセル
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
