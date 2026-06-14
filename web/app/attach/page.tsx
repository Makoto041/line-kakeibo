"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Paperclip, Check, RefreshCw, Camera, Upload, Image as ImageIcon } from "lucide-react";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { db, storage, ensureFirebaseInitialized } from "../../lib/firebase";
import { isSafeImageUrl } from "../../lib/imageUrl";
import { compressImage } from "../../lib/imageCompress";
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

function AttachPageContent() {
  const searchParams = useSearchParams();
  const expenseId = searchParams.get("expenseId");

  const [expense, setExpense] = useState<ExpenseSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // アンマウント後の setState を防ぐ（アップロードはバックグラウンドで継続する）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  // アップロード処理（バックグラウンド／進捗表示）。
  // resumable アップロードで進捗を表示し、完了時に Firestore へ receiptUrl を保存する。
  // 完了処理はReactのマウント状態に依存しないため、ページを離れても継続する。
  const handleUpload = async () => {
    if (!selectedFile || !expenseId) return;

    setUploading(true);
    setUploadProgress(0);
    setError(null);

    try {
      ensureFirebaseInitialized();
      if (!storage || !db) {
        throw new Error("Firebaseの初期化に失敗しました。");
      }

      // アップロード前にリサイズ＋JPEG再エンコードで圧縮（容量・帯域の長期削減）
      const { file: uploadFile, compressed, originalSize, outputSize } =
        await compressImage(selectedFile);
      if (compressed) {
        console.log(
          `レシート圧縮: ${(originalSize / 1024).toFixed(0)}KB → ${(outputSize / 1024).toFixed(0)}KB ` +
            `(${Math.round((1 - outputSize / originalSize) * 100)}%削減)`
        );
      }

      // パス: receipts/{expenseId}/{timestamp}_{filename}
      const timestamp = Date.now();
      const safeName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageRef = ref(storage, `receipts/${expenseId}/${timestamp}_${safeName}`);
      const targetExpenseId = expenseId;

      const task = uploadBytesResumable(storageRef, uploadFile, {
        contentType: uploadFile.type,
      });

      task.on(
        "state_changed",
        (snapshot) => {
          const pct = snapshot.totalBytes
            ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
            : 0;
          if (mountedRef.current) setUploadProgress(pct);
        },
        (err) => {
          console.error("Upload failed:", err);
          if (mountedRef.current) {
            setError(
              "アップロードに失敗しました。" +
                (err instanceof Error ? ` (${err.message})` : "")
            );
            setUploading(false);
          }
        },
        async () => {
          // 完了: ダウンロードURL取得 → Firestore保存（バックグラウンドでも実行される）
          try {
            const downloadUrl = await getDownloadURL(task.snapshot.ref);
            await updateDoc(doc(db!, "expenses", targetExpenseId), {
              receiptUrl: downloadUrl,
              updatedAt: new Date(),
            });
            if (mountedRef.current) {
              setExpense((prev) => (prev ? { ...prev, receiptUrl: downloadUrl } : prev));
              setUploadDone(true);
              setReplacing(false);
              setSelectedFile(null);
              setPreviewDataUrl(null);
              setUploading(false);
            }
          } catch (err) {
            console.error("Failed to finalize upload:", err);
            if (mountedRef.current) {
              setError("アップロードの保存に失敗しました。");
              setUploading(false);
            }
          }
        }
      );
    } catch (err) {
      console.error("Upload failed:", err);
      setError(
        "アップロードに失敗しました。" +
          (err instanceof Error ? ` (${err.message})` : "")
      );
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

                {/* アルバム選択用（capture なし → 写真ライブラリ/ファイルから選べる） */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
                {/* 撮影用（capture あり → カメラ起動） */}
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  className="hidden"
                />

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line p-5 text-center transition-colors hover:border-accent hover:bg-accent/[0.04]"
                  >
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/12 text-accent">
                      <ImageIcon className="h-5 w-5" strokeWidth={1.9} />
                    </span>
                    <span className="text-sm font-medium text-fg">アルバムから選択</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line p-5 text-center transition-colors hover:border-accent hover:bg-accent/[0.04]"
                  >
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/12 text-accent">
                      <Camera className="h-5 w-5" strokeWidth={1.9} />
                    </span>
                    <span className="text-sm font-medium text-fg">写真を撮る</span>
                  </button>
                </div>

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
                  {uploading ? `アップロード中... ${uploadProgress}%` : "アップロードする"}
                </button>

                {uploading && (
                  <div className="space-y-1.5">
                    <div className="relative h-1.5 overflow-hidden rounded-full bg-fg/10">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                    <p className="text-center text-xs text-muted">
                      バックグラウンドで送信中です。このページを離れても続行されます。
                    </p>
                  </div>
                )}

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
