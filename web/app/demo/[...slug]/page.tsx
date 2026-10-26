import { notFound } from 'next/navigation';

// /demo 以下の、どの場面にも当たらない URL。入れ子の not-found（app/demo/not-found.tsx）は、同じ区間で
// notFound() を呼んだときだけ使われるので、ここで呼んでデモの 404（目次へ戻るリンク）を出す
export default function DemoCatchAllPage() {
  notFound();
}
