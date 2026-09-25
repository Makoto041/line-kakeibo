"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Paperclip, Check, RefreshCw, Camera, Upload, Image as ImageIcon, CircleAlert } from "lucide-react";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { db, storage, ensureFirebaseInitialized } from "../../lib/firebase";
import { isSafeImageUrl } from "../../lib/imageUrl";
import { compressImage } from "../../lib/imageCompress";
import dayjs from "dayjs";
import { isLineAuthSettled, onLineAuthSettled } from "../../lib/lineAuth";
import { cx } from "../../lib/cx";
import { Amount } from "../../components/ui/Amount";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { ExpenseIcon } from "../../components/expense/ExpenseIcon";

// storage.rules と揃える（SVG・GIF は不可、上限 5MB）
const ALLOWED_RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

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
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
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
  // 認証の確定（匿名セッションの復元 → LINE の順に変わる）を待ってから支出を読む。
  // 確定前に読むと、LINE から初めて開いたときに権限エラーになる
  const [authSettled, setAuthSettled] = useState(() => isLineAuthSettled());
  useEffect(() => onLineAuthSettled(() => setAuthSettled(true)), []);

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

    if (expenseId && !authSettled) return;
    fetchExpense();
  }, [expenseId, authSettled]);

  // ファイル選択時の処理
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_RECEIPT_TYPES.includes(file.type)) {
      setError("JPEG / PNG / WebP / HEIC 形式の画像を選択してください。");
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

      // Storage ルールと同じ上限（圧縮後のサイズで判定する）
      if (uploadFile.size > MAX_RECEIPT_BYTES) {
        throw new Error("画像が大きすぎます（5MB まで）。");
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
    <div className="mx-auto min-h-dvh w-full max-w-[440px] pb-10">
      <header
        className="flex items-center gap-3 pl-6 pr-4"
        style={{ paddingTop: "calc(var(--kb-header-top) + var(--kb-safe-top))" }}
      >
        <span className="kb-glass grid h-12 w-12 shrink-0 place-items-center rounded-full text-ink">
          <Paperclip size={22} strokeWidth={2} aria-hidden="true" />
        </span>
        <h1 className="min-w-0 truncate text-kb-title text-ink">レシート添付</h1>
      </header>

      <main className="mt-6 space-y-4 px-4">
        {error && (
          <div role="alert" className="kb-card flex items-start gap-3 rounded-kb-row px-4 py-3.5 text-danger-ink">
            <CircleAlert size={20} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
            <p className="text-kb-body">{error}</p>
          </div>
        )}

        {expense && (
          <>
            {/* 支出概要 */}
            <section aria-label="対象の支出" className="kb-card rounded-kb-card px-5 py-5">
              <div className="flex items-center gap-3">
                <span className="kb-glass-2 grid h-12 w-12 shrink-0 place-items-center rounded-full">
                  <ExpenseIcon description={expense.description} category={expense.category} size={24} />
                </span>
                <p className="min-w-0 break-words text-kb-row text-ink">{expense.description}</p>
              </div>
              <Amount value={expense.amount} base={44} className="mt-3 block text-ink" />
              <p className="mt-1 text-kb-caption text-ink-3">
                {expense.date ? dayjs(expense.date).format("YYYY年M月D日") : "日付不明"}
                {expense.category ? ` ・ ${expense.category}` : ""}
              </p>
            </section>

            {/* アップロード完了メッセージ */}
            {uploadDone && (
              <div role="status" className="kb-strip-ok flex items-start gap-2.5 rounded-kb-row px-4 py-3.5">
                <Check size={20} strokeWidth={2.4} aria-hidden="true" className="mt-0.5 shrink-0" />
                <p className="text-kb-body font-medium">レシートを添付しました。このページは閉じて構いません。</p>
              </div>
            )}

            {/* 既存レシートのプレビュー */}
            {hasReceipt && (
              <section className="kb-card rounded-kb-card p-4">
                <h2 className="mb-3 px-1 text-kb-caption font-medium text-ink-3">添付済みのレシート</h2>
                {expense.receiptUrl && isSafeImageUrl(expense.receiptUrl) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={expense.receiptUrl}
                    alt="添付済みレシート"
                    className="w-full rounded-2xl bg-skeleton"
                  />
                )}
                {!replacing && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplacing(true);
                      setUploadDone(false);
                    }}
                    className={cx(SECONDARY, "mt-4 w-full")}
                  >
                    <RefreshCw size={20} strokeWidth={2} aria-hidden="true" />
                    レシートを差し替える
                  </button>
                )}
              </section>
            )}

            {/* アップロードフォーム */}
            {showUploadForm && (
              <section className="kb-card space-y-4 rounded-kb-card p-4">
                <h2 className="px-1 text-kb-caption font-medium text-ink-3">
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
                  <button type="button" onClick={() => fileInputRef.current?.click()} className={PICKER}>
                    <span className="kb-btn-primary grid h-12 w-12 place-items-center rounded-full">
                      <ImageIcon size={22} strokeWidth={2} aria-hidden="true" />
                    </span>
                    <span className="text-kb-chip text-ink">アルバムから選択</span>
                  </button>
                  <button type="button" onClick={() => cameraInputRef.current?.click()} className={PICKER}>
                    <span className="kb-btn-primary grid h-12 w-12 place-items-center rounded-full">
                      <Camera size={22} strokeWidth={2} aria-hidden="true" />
                    </span>
                    <span className="text-kb-chip text-ink">写真を撮る</span>
                  </button>
                </div>

                {previewDataUrl && (
                  <div>
                    <h3 className="mb-2 px-1 text-kb-caption font-medium text-ink-3">プレビュー</h3>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={previewDataUrl}
                      alt="選択した画像のプレビュー"
                      className="w-full rounded-2xl bg-skeleton"
                    />
                  </div>
                )}

                <PrimaryButton
                  icon={Upload}
                  height={56}
                  onClick={handleUpload}
                  disabled={!selectedFile || uploading}
                >
                  {uploading ? `アップロード中... ${uploadProgress}%` : "アップロードする"}
                </PrimaryButton>

                {uploading && (
                  <div className="space-y-1.5">
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={uploadProgress}
                      aria-label="アップロード"
                      className="relative h-2 overflow-hidden rounded-full"
                      style={{ background: "var(--kb-bar-track)" }}
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-200"
                        style={{ width: `${uploadProgress}%`, background: "var(--kb-bar-grad)" }}
                      />
                    </div>
                    <p className="text-center text-kb-caption text-ink-3">
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
                    className={cx(SECONDARY, "w-full")}
                  >
                    キャンセル
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const SECONDARY =
  "kb-glass-2 inline-flex h-[52px] items-center justify-center gap-2.5 rounded-full px-4 text-[17px] font-semibold text-ink transition-[transform,opacity] duration-150 active:scale-[0.98]";
const PICKER =
  "kb-glass-2 flex flex-col items-center gap-2.5 rounded-kb-row px-3 py-5 text-center transition-transform duration-150 active:scale-[0.98]";
