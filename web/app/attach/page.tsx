"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Paperclip, Check, RefreshCw, Camera, Upload } from "lucide-react";
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
    <div className="flex min-h-dvh items-center justify-center">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
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
    <div className="min-h-dvh">
      <header className="glass-bar sticky top-0 z-10 border-b border-line/60">
        <div className="mx-auto flex max-w-lg items-center gap-2 px-4 py-4">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent text-accent-fg">
            <Paperclip className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-fg">レシート添付</h1>
        </div>
      </header>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
        {error && (
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/[0.06] p-4">
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          </div>
        )}

        {expense && (
          <>
            {/* 支出概要 */}
            <div className="glass rounded-2xl p-5 shadow-glass">
              <h2 className="mb-3 text-sm font-medium text-muted">対象の支出</h2>
              <p className="break-words text-lg font-semibold text-fg">
                {expense.description}
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-fg">
                ¥{expense.amount.toLocaleString()}
              </p>
              <p className="mt-1 text-sm text-muted">
                {expense.date
                  ? dayjs(expense.date).format("YYYY年M月D日")
                  : "日付不明"}
                {expense.category ? ` ・ ${expense.category}` : ""}
              </p>
            </div>

            {/* アップロード完了メッセージ */}
            {uploadDone && (
              <div className="flex items-start gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.08] p-4 text-emerald-700 dark:text-emerald-300">
                <Check className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.4} />
                <p className="text-sm font-medium">レシートを添付しました。このページは閉じて構いません。</p>
              </div>
            )}

            {/* 既存レシートのプレビュー */}
            {hasReceipt && (
              <div className="glass rounded-2xl p-5 shadow-glass">
                <h2 className="mb-3 text-sm font-medium text-muted">
                  添付済みのレシート
                </h2>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {expense.receiptUrl && isSafeImageUrl(expense.receiptUrl) && (
                  <img
                    src={expense.receiptUrl}
                    alt="添付済みレシート"
                    className="w-full rounded-lg border border-line"
                  />
                )}
                {!replacing && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplacing(true);
                      setUploadDone(false);
                    }}
                    className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-card px-4 py-3 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
                  >
                    <RefreshCw className="h-4 w-4" />
                    レシートを差し替える
                  </button>
                )}
              </div>
            )}

            {/* アップロードフォーム */}
            {showUploadForm && (
              <div className="glass space-y-4 rounded-2xl p-5 shadow-glass">
                <h2 className="text-sm font-medium text-muted">
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
                  className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line p-6 text-center transition-colors hover:border-accent hover:bg-accent/[0.04]"
                >
                  <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent/12 text-accent">
                    <Camera className="h-6 w-6" strokeWidth={1.9} />
                  </span>
                  <span className="text-sm text-muted">
                    タップして撮影 / 画像を選択
                  </span>
                </button>

                {previewDataUrl && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium text-muted">
                      プレビュー
                    </h3>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={previewDataUrl}
                      alt="選択した画像のプレビュー"
                      className="w-full rounded-lg border border-line"
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={!selectedFile || uploading}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-3 text-sm font-medium text-accent-fg transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Upload className="h-4 w-4" />
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
                    className="w-full rounded-lg border border-line bg-card px-4 py-3 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
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
