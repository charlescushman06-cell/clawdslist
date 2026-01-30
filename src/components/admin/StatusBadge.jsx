import React from 'react';

const STATUS_STYLES = {
  // Task statuses
  open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  claimed: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  completed: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  expired: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  disputed: 'bg-red-500/10 text-red-400 border-red-500/30',
  cancelled: 'bg-slate-500/10 text-slate-500 border-slate-500/30',
  
  // Worker statuses
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  suspended: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  revoked: 'bg-red-500/10 text-red-400 border-red-500/30',
  
  // Submission statuses
  pending: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  approved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/30'
};

export default function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || 'bg-slate-500/10 text-slate-400 border-slate-500/30';
  
  return (
    <span className={`px-2 py-0.5 text-xs font-mono uppercase tracking-wider rounded border ${style}`}>
      {status}
    </span>
  );
}