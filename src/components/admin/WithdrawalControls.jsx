import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { 
  ShieldAlert, 
  TrendingUp, 
  Clock, 
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';

export default function WithdrawalControls() {
  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['withdrawal-config'],
    queryFn: async () => {
      const res = await base44.functions.invoke('withdrawalRisk', { action: 'get_config' });
      return res.data;
    }
  });

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['outflow-stats'],
    queryFn: async () => {
      const res = await base44.functions.invoke('withdrawalRisk', { action: 'get_outflow_stats' });
      return res.data;
    },
    refetchInterval: 30000 // Refresh every 30s
  });

  if (configLoading || statsLoading) {
    return (
      <div className="bg-slate-950 border border-red-900/50 rounded-lg p-6">
        <div className="flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-red-500 animate-spin" />
        </div>
      </div>
    );
  }

  const chains = ['ETH', 'BTC'];

  const getProgressColor = (current, limit) => {
    const ratio = parseFloat(current) / parseFloat(limit);
    if (ratio >= 0.9) return 'bg-red-500';
    if (ratio >= 0.7) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const getProgressValue = (current, limit) => {
    const ratio = (parseFloat(current) / parseFloat(limit)) * 100;
    return Math.min(ratio, 100);
  };

  return (
    <div className="bg-slate-950 border border-red-900/50 rounded-lg">
      <div className="p-4 border-b border-red-900/30 flex items-center gap-3">
        <ShieldAlert className="w-5 h-5 text-red-500" />
        <div>
          <h2 className="text-lg text-slate-100">Withdrawal Controls</h2>
          <p className="text-xs text-slate-500">Circuit breakers & outflow limits</p>
        </div>
      </div>

      <div className="p-4 space-y-6">
        {chains.map(chain => {
          const chainStats = stats?.[chain];
          const chainConfig = config?.[chain];
          const isDisabled = chainConfig?.circuit_breaker_active;

          return (
            <div key={chain} className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 text-xs font-bold rounded ${
                    chain === 'ETH' ? 'bg-blue-900/50 text-blue-400' : 'bg-orange-900/50 text-orange-400'
                  }`}>
                    {chain}
                  </span>
                  <span className="text-sm text-slate-300">Circuit Breaker</span>
                </div>
                {isDisabled ? (
                  <span className="flex items-center gap-1.5 px-2 py-1 bg-red-900/30 border border-red-500/50 rounded text-xs text-red-400">
                    <XCircle className="w-3.5 h-3.5" />
                    DISABLED
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 px-2 py-1 bg-green-900/30 border border-green-500/50 rounded text-xs text-green-400">
                    <CheckCircle className="w-3.5 h-3.5" />
                    Active
                  </span>
                )}
              </div>

              {/* Hourly Outflow */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-slate-400">
                    <Clock className="w-3.5 h-3.5" />
                    Hourly Outflow
                  </span>
                  <span className="text-slate-300 font-mono">
                    {chainStats?.hourly_outflow || '0'} / {chainConfig?.HOT_WALLET_MAX_PER_HOUR} {chain}
                  </span>
                </div>
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all ${getProgressColor(chainStats?.hourly_outflow || '0', chainConfig?.HOT_WALLET_MAX_PER_HOUR || '1')}`}
                    style={{ width: `${getProgressValue(chainStats?.hourly_outflow || '0', chainConfig?.HOT_WALLET_MAX_PER_HOUR || '1')}%` }}
                  />
                </div>
              </div>

              {/* Daily Outflow */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-slate-400">
                    <TrendingUp className="w-3.5 h-3.5" />
                    Daily Outflow
                  </span>
                  <span className="text-slate-300 font-mono">
                    {chainStats?.daily_outflow || '0'} / {chainConfig?.HOT_WALLET_MAX_PER_DAY} {chain}
                  </span>
                </div>
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all ${getProgressColor(chainStats?.daily_outflow || '0', chainConfig?.HOT_WALLET_MAX_PER_DAY || '1')}`}
                    style={{ width: `${getProgressValue(chainStats?.daily_outflow || '0', chainConfig?.HOT_WALLET_MAX_PER_DAY || '1')}%` }}
                  />
                </div>
              </div>

              {/* Withdrawal Counts */}
              <div className="flex gap-4 text-xs text-slate-500">
                <span>Hourly: {chainStats?.hourly_count || 0} txs</span>
                <span>Daily: {chainStats?.daily_count || 0} txs</span>
              </div>

              {chain !== 'BTC' && <div className="border-b border-red-900/20 pt-2" />}
            </div>
          );
        })}

        {/* Warning Banner */}
        <div className="mt-4 p-3 bg-yellow-900/20 border border-yellow-500/30 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-yellow-400/80">
              <p className="font-semibold text-yellow-400 mb-1">Environment Variables</p>
              <p>Circuit breakers and limits are controlled via environment variables:</p>
              <ul className="mt-1 space-y-0.5 text-yellow-500/70 font-mono">
                <li>• DISABLE_WITHDRAWALS_ETH / DISABLE_WITHDRAWALS_BTC</li>
                <li>• MAX_HOT_WALLET_OUTFLOW_PER_HOUR_ETH</li>
                <li>• MAX_HOT_WALLET_OUTFLOW_PER_DAY_ETH</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}