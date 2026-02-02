import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { 
  Clock, 
  DollarSign, 
  Shield, 
  Eye, 
  CheckCircle, 
  XCircle,
  AlertCircle,
  Bot,
  Timer
} from 'lucide-react';
import { format } from 'date-fns';

const STATUS_CONFIG = {
  open: { 
    color: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
    icon: AlertCircle,
    label: 'Open for Bots'
  },
  claimed: { 
    color: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
    icon: Clock,
    label: 'Bot Working'
  },
  completed: { 
    color: 'bg-green-500/10 text-green-400 border-green-500/30',
    icon: CheckCircle,
    label: 'Completed'
  },
  cancelled: {
    color: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
    icon: XCircle,
    label: 'Cancelled'
  },
  expired: { 
    color: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
    icon: XCircle,
    label: 'Expired'
  }
};

export default function HumanTaskCard({ task, submissions, capabilities = [] }) {
  // Build a map of capability_id -> capability for quick lookup
  const capabilityMap = React.useMemo(() => {
    const map = {};
    capabilities.forEach(cap => { map[cap.id] = cap; });
    return map;
  }, [capabilities]);

  // Get required capability objects for this task
  const requiredCaps = React.useMemo(() => {
    if (!task.required_capabilities || task.required_capabilities.length === 0) return [];
    return task.required_capabilities
      .map(capId => capabilityMap[capId])
      .filter(Boolean);
  }, [task.required_capabilities, capabilityMap]);
  const [showDetails, setShowDetails] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [showEth, setShowEth] = useState(true);

  // Animated price swap for trading terminal effect
  useEffect(() => {
    if (task.reward && task.task_price_usd) {
      const interval = setInterval(() => {
        setShowEth(prev => !prev);
      }, 2500);
      return () => clearInterval(interval);
    }
  }, [task.reward, task.task_price_usd]);
  
  // Determine if task is effectively expired (claim timeout or deadline passed)
  const isEffectivelyExpired = (() => {
    const now = new Date();
    if (task.status === 'expired') return true;
    if (task.status === 'claimed' && task.claimed_at) {
      const claimExpiry = new Date(new Date(task.claimed_at).getTime() + (task.claim_timeout_minutes || 30) * 60 * 1000);
      if (now > claimExpiry) return true;
    }
    if (task.status === 'open' && task.expires_at && now > new Date(task.expires_at)) return true;
    if (task.status === 'open' && task.deadline && now > new Date(task.deadline)) return true;
    return false;
  })();
  
  // Use expired status config if effectively expired
  const effectiveStatus = isEffectivelyExpired ? 'expired' : task.status;
  const statusConfig = STATUS_CONFIG[effectiveStatus] || STATUS_CONFIG.open;
  const StatusIcon = statusConfig.icon;

  // Calculate time remaining for claimed tasks or deadline for open tasks
  useEffect(() => {
    const calculateTimeRemaining = () => {
      const now = new Date();
      
      if (task.status === 'claimed' && task.claimed_at) {
        // Time remaining on claim
        const claimExpiry = new Date(new Date(task.claimed_at).getTime() + (task.claim_timeout_minutes || 30) * 60 * 1000);
        const remaining = claimExpiry.getTime() - now.getTime();
        return remaining > 0 ? remaining : 0;
      } else if (task.status === 'open' && task.expires_at) {
        // Time remaining until expires_at
        const expiresAt = new Date(task.expires_at);
        const remaining = expiresAt.getTime() - now.getTime();
        return remaining > 0 ? remaining : 0;
      } else if (task.status === 'open' && task.deadline) {
        // Fallback to deadline
        const deadline = new Date(task.deadline);
        const remaining = deadline.getTime() - now.getTime();
        return remaining > 0 ? remaining : 0;
      }
      return null;
    };

    setTimeRemaining(calculateTimeRemaining());

    // Update every second
    const interval = setInterval(() => {
      setTimeRemaining(calculateTimeRemaining());
    }, 1000);

    return () => clearInterval(interval);
  }, [task.status, task.claimed_at, task.deadline, task.expires_at, task.claim_timeout_minutes]);

  const formatTimeRemaining = (ms) => {
    if (ms === null || ms === undefined) return null;
    if (ms <= 0) return '0:00';
    
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const getTimeColor = (ms) => {
    if (ms === null || ms === undefined) return 'text-slate-400';
    const minutes = ms / 60000;
    if (minutes <= 2) return 'text-red-500 animate-pulse';
    if (minutes <= 5) return 'text-red-400';
    if (minutes <= 10) return 'text-yellow-400';
    return 'text-green-400';
  };

  const formatOutput = (output) => {
    try {
      return JSON.stringify(JSON.parse(output), null, 2);
    } catch {
      return output;
    }
  };

  return (
    <>
      <div className="bg-slate-900 border border-red-500/40 rounded-none p-3 sm:p-5 hover:border-red-500/70 shadow-[0_0_15px_rgba(239,68,68,0.15)] hover:shadow-[0_0_25px_rgba(239,68,68,0.25)] transition-all flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm sm:text-base font-semibold text-slate-100 truncate">{task.title}</h3>
            </div>
            <p className="text-xs sm:text-sm text-slate-400 line-clamp-2">{task.description}</p>
            {/* Required Capabilities */}
            {requiredCaps.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {requiredCaps.map(cap => (
                  <span 
                    key={cap.id}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-black border border-slate-700 text-[9px] sm:text-[10px] font-mono text-slate-400"
                  >
                    <span>{cap.icon || '⚡'}</span>
                    <span className="uppercase tracking-wider">{cap.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <Badge className={`${statusConfig.color} flex items-center gap-1 whitespace-nowrap text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5`}>
            <StatusIcon className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
            <span className="hidden sm:inline">{statusConfig.label}</span>
            <span className="sm:hidden">{statusConfig.label.split(' ')[0]}</span>
          </Badge>
        </div>

        {/* Metadata - Trading Terminal Style */}
        <div className="grid grid-cols-3 gap-px mb-3 bg-slate-800 border border-slate-700">
          <div className="bg-black p-2 text-center">
            <p className="text-[9px] sm:text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">REWARD</p>
            <div className="font-mono text-green-400 text-xs sm:text-sm font-bold h-5 flex items-center justify-center">
              {task.reward && task.task_price_usd ? (
                <span className={`transition-opacity duration-200 ${showEth ? 'opacity-100' : 'opacity-0 absolute'}`}>
                  {task.reward} <span className="text-slate-500 text-[10px]">ETH</span>
                </span>
              ) : null}
              {task.reward && task.task_price_usd ? (
                <span className={`transition-opacity duration-200 ${!showEth ? 'opacity-100' : 'opacity-0 absolute'}`}>
                  ${task.task_price_usd}
                </span>
              ) : (
                <span>
                  {task.reward ? `${task.reward}` : task.task_price_usd ? `$${task.task_price_usd}` : '--'}
                </span>
              )}
            </div>
          </div>
          <div className="bg-black p-2 text-center">
            <p className="text-[9px] sm:text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">STAKE</p>
            <div className="font-mono text-yellow-400 text-xs sm:text-sm font-bold">
              ${task.required_stake_usd || '0'}
            </div>
          </div>
          <div className="bg-black p-2 text-center">
            <p className="text-[9px] sm:text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">
              {(task.status === 'claimed' || (task.status === 'open' && (task.expires_at || task.deadline))) && timeRemaining !== null
                ? (timeRemaining === 0 ? 'EXPIRED' : 'TTL')
                : 'TIMEOUT'}
            </p>
            <div className={`font-mono text-xs sm:text-sm font-bold ${
              (task.status === 'claimed' || (task.status === 'open' && (task.expires_at || task.deadline))) && timeRemaining !== null
                ? (timeRemaining === 0 ? 'text-red-500' : getTimeColor(timeRemaining))
                : 'text-slate-400'
            }`}>
              {(task.status === 'claimed' || (task.status === 'open' && (task.expires_at || task.deadline))) && timeRemaining !== null
                ? (timeRemaining === 0 ? '--:--' : formatTimeRemaining(timeRemaining))
                : `${task.claim_timeout_minutes || '--'}m`}
            </div>
          </div>
        </div>

        {/* Submissions Info - Trading Terminal Style */}
        {submissions.length > 0 && (
          <div className="mb-3 bg-black border border-slate-700 flex">
            <div className={`px-2 py-1.5 flex items-center gap-1.5 border-r border-slate-700 ${submissions.some(s => s.status === 'approved') ? 'text-green-400' : 'text-blue-400'}`}>
              <CheckCircle className="w-3.5 h-3.5" />
              <span className="font-mono text-xs font-bold">{submissions.length}</span>
            </div>
            <div className="px-2 py-1.5 flex-1">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider">
                {submissions.some(s => s.status === 'approved') 
                  ? `${submissions.filter(s => s.status === 'approved').length} VERIFIED`
                  : `${submissions.filter(s => s.status === 'pending').length} PENDING`}
              </span>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-800 mt-auto">
          <div className="text-[10px] sm:text-xs text-slate-500">
            {format(new Date(task.created_date), 'MMM d')}
          </div>
          <button 
            onClick={() => setShowDetails(true)}
            className="bg-black border border-slate-700 hover:border-slate-500 px-3 py-1.5 text-[10px] sm:text-xs font-mono uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-all flex items-center gap-1.5"
          >
            <Eye className="w-3 h-3" />
            <span>INSPECT</span>
          </button>
        </div>
      </div>

      {/* Details Dialog */}
      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent className="bg-black border border-slate-700 p-0 max-w-3xl max-h-[90vh] overflow-hidden mx-2 sm:mx-auto w-[calc(100%-1rem)] sm:w-full">
          {/* Terminal Header */}
          <div className="bg-slate-900 border-b border-slate-700 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
              </div>
              <span className="font-mono text-xs text-slate-500 uppercase tracking-wider">TASK_INSPECTOR</span>
            </div>
            <Badge className={`${statusConfig.color} font-mono text-[10px] uppercase`}>
              {statusConfig.label}
            </Badge>
          </div>
          
          <div className="overflow-y-auto max-h-[calc(90vh-60px)] p-4 space-y-4">
            {/* Task Title */}
            <div className="border-b border-slate-800 pb-3">
              <p className="text-[10px] text-slate-600 uppercase tracking-wider mb-1">TASK_ID</p>
              <h2 className="font-mono text-base sm:text-lg text-slate-100">{task.title}</h2>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-slate-800">
              <div className="bg-black p-3">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">REWARD</p>
                <p className="font-mono text-sm text-green-400 font-bold">
                  {task.reward ? `${task.reward} ETH` : `$${task.task_price_usd || 0}`}
                </p>
              </div>
              <div className="bg-black p-3">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">STAKE_REQ</p>
                <p className="font-mono text-sm text-yellow-400 font-bold">${task.required_stake_usd || 0}</p>
              </div>
              <div className="bg-black p-3">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">TIMEOUT</p>
                <p className="font-mono text-sm text-slate-300">{task.claim_timeout_minutes || '--'}m</p>
              </div>
              <div className="bg-black p-3">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">SLASH_%</p>
                <p className="font-mono text-sm text-red-400">{task.slash_percentage || 0}%</p>
              </div>
            </div>

            {/* Task Info */}
            <div className="grid grid-cols-2 gap-px bg-slate-800">
              <div className="bg-black p-3">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">TYPE</p>
                <p className="font-mono text-xs text-slate-300">{task.type}</p>
              </div>
              <div className="bg-black p-3">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">PRIORITY</p>
                <p className="font-mono text-xs text-slate-300">{task.priority || 0}/10</p>
              </div>
            </div>

            {/* Description */}
            <div className="bg-slate-900/50 border border-slate-800 p-3">
              <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-2">DESCRIPTION</p>
              <p className="font-mono text-xs text-slate-400 whitespace-pre-wrap leading-relaxed">{task.description}</p>
            </div>

            {/* Requirements */}
            {task.requirements && (
              <div className="bg-slate-900/50 border border-slate-800 p-3">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-2">REQUIREMENTS</p>
                <p className="font-mono text-xs text-slate-400 whitespace-pre-wrap leading-relaxed">{task.requirements}</p>
              </div>
            )}

            {/* Submissions */}
            {submissions.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3 border-b border-slate-800 pb-2">
                  <CheckCircle className={`w-4 h-4 ${submissions.some(s => s.status === 'approved') ? 'text-green-400' : 'text-blue-400'}`} />
                  <span className="font-mono text-xs text-slate-500 uppercase tracking-wider">
                    SUBMISSIONS [{submissions.length}]
                  </span>
                </div>
                <div className="space-y-2">
                  {submissions.map(sub => (
                    <div key={sub.id} className="bg-slate-900/50 border border-slate-800">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900">
                        <div className="flex items-center gap-2">
                          <Bot className="w-3 h-3 text-slate-500" />
                          <span className="font-mono text-xs text-slate-400">{sub.worker_name}</span>
                        </div>
                        <span className={`font-mono text-[10px] uppercase ${
                          sub.status === 'approved' ? 'text-green-400' :
                          sub.status === 'rejected' ? 'text-red-400' :
                          'text-blue-400'
                        }`}>
                          {sub.status}
                        </span>
                      </div>
                      <div className="p-3">
                        <p className="text-[9px] text-slate-600 mb-2">
                          {format(new Date(sub.created_date), 'yyyy-MM-dd HH:mm:ss')}
                        </p>
                        <pre className="bg-black border border-slate-800 p-2 font-mono text-[10px] sm:text-xs text-slate-400 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
                          {formatOutput(sub.output_data)}
                        </pre>
                        {sub.review_notes && (
                          <p className="font-mono text-[10px] text-slate-500 mt-2 border-t border-slate-800 pt-2">
                            // {sub.review_notes}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}