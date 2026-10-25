import type { ReactNode } from 'react';
import { STATUS_LABELS, type TaskStatus } from '../shared/domain.ts';

// 상태는 색만으로 구분하지 않고 아이콘·글자를 함께 쓴다(PRD F-G03).
export function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'done') {
    return (
      <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="5.25" fill="currentColor" />
        <path d="M3.6 6.1 L5.3 7.7 L8.4 4.5" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {status === 'in-progress' && <path d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor" />}
    </svg>
  );
}

export function StatusChip({ status, children }: { status: TaskStatus; children?: ReactNode }) {
  return (
    <span className={`chip status-${status}`}>
      <StatusIcon status={status} />
      {children ?? STATUS_LABELS[status]}
    </span>
  );
}

export function WarnIcon() {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.6 L10.9 10.2 H1.1 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 5 V7.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="8.7" r="0.7" fill="currentColor" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 6.2 L5 8.5 L9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DocIcon({ label }: { label: string }) {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" role="img" aria-label={label}>
      <path d="M3 1.5 H7.2 L9.5 3.8 V10.5 H3 Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7 1.5 V4 H9.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M7 2 H10 V5 M10 2 L5.5 6.5 M8.5 7 V10 H2 V3.5 H5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M9.5 2.5 L11.5 4.5 L5 11 H3 V9 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3 V13 M3 8 H13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 8 A5.5 5.5 0 1 1 11.9 4.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M13.5 2.5 V6 H10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LayoutIcon() {
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2" width="4" height="4" rx="1" />
      <rect x="10.5" y="2" width="4" height="4" rx="1" />
      <rect x="10.5" y="10" width="4" height="4" rx="1" />
      <path d="M5.5 4 H10.5 M8 4 V12 H10.5" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
      <path d="M8 2.2 H2.8 A0.8 0.8 0 0 0 2 3 V8" strokeLinecap="round" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg className="icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 5.8 V10.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="10" cy="13.9" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowDownIcon() {
  return (
    <svg className="icon" width="16" height="24" viewBox="0 0 16 24" aria-hidden="true">
      <path d="M8 2 V20 M3 15 L8 20 L13 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function InfoIcon() {
  return (
    <svg className="icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="6.2" r="1.1" fill="currentColor" />
      <path d="M10 9.2 V14.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 하위 공정을 품은 공정 표시(겹친 카드) */
export function StackIcon() {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="1.5" y="4" width="7" height="6.5" rx="1.2" />
      <path d="M3.5 2 H9.2 A0.8 0.8 0 0 1 10 2.8 V8" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronRightIcon() {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5 L8 6 L4.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
