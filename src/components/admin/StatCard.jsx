import React from 'react';

export default function StatCard({ label, value, sublabel, icon: Icon }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-slate-500 text-xs uppercase tracking-wider font-mono">{label}</p>
          <p className="text-2xl font-mono text-slate-100 mt-1">{value}</p>
          {sublabel && <p className="text-slate-500 text-xs mt-1">{sublabel}</p>}
        </div>
        {Icon && (
          <div className="p-2 bg-slate-800 rounded">
            <Icon className="w-4 h-4 text-amber-500" />
          </div>
        )}
      </div>
    </div>
  );
}