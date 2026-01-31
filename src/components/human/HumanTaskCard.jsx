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

export default function HumanTaskCard({ task, submissions }) {
  const [showDetails, setShowDetails] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const statusConfig = STATUS_CONFIG[task.status] || STATUS_CONFIG.open;
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
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-colors">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-lg font-semibold text-slate-100">{task.title}</h3>
            </div>
            <p className="text-sm text-slate-400 line-clamp-2">{task.description}</p>
          </div>
          <Badge className={`${statusConfig.color} flex items-center gap-1 whitespace-nowrap ml-4`}>
            <StatusIcon className="w-3 h-3" />
            {statusConfig.label}
          </Badge>
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-3 gap-3 mb-4 p-3 bg-black/50 border border-red-900/30 rounded-lg">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-red-400 mb-1">
              <DollarSign className="w-4 h-4" />
              <span className="text-sm font-semibold">
                {task.reward ? `${task.reward} ${task.currency || 'ETH'}` : task.task_price_usd ? `$${task.task_price_usd}` : '0'}
              </span>
            </div>
            <p className="text-xs text-slate-500">Payment</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-red-400 mb-1">
              <Shield className="w-4 h-4" />
              <span className="text-sm font-semibold">{task.required_stake_usd || 0}</span>
            </div>
            <p className="text-xs text-slate-500">Bot Stake</p>
          </div>
          <div className="text-center">
            {(task.status === 'claimed' || (task.status === 'open' && (task.expires_at || task.deadline))) && timeRemaining !== null ? (
              timeRemaining === 0 ? (
                <>
                  <div className="flex items-center justify-center gap-1 mb-1 text-red-500">
                    <XCircle className="w-4 h-4" />
                    <span className="text-sm font-semibold">Expired</span>
                  </div>
                  <p className="text-xs text-slate-500">Time Up</p>
                </>
              ) : (
                <>
                  <div className={`flex items-center justify-center gap-1 mb-1 ${getTimeColor(timeRemaining)}`}>
                    <Timer className="w-4 h-4" />
                    <span className="text-sm font-semibold">{formatTimeRemaining(timeRemaining)}</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {task.status === 'claimed' ? 'Time Left' : 'Expires In'}
                  </p>
                </>
              )
            ) : (
              <>
                <div className="flex items-center justify-center gap-1 text-red-400 mb-1">
                  <Clock className="w-4 h-4" />
                  <span className="text-sm font-semibold">{task.claim_timeout_minutes || '-'}</span>
                </div>
                <p className="text-xs text-slate-500">Minutes</p>
              </>
            )}
          </div>
        </div>

        {/* Submissions Info */}
        {submissions.length > 0 && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="flex items-center gap-2 text-red-400 mb-1">
              <Bot className="w-4 h-4" />
              <span className="text-sm font-semibold">{submissions.length} Submission{submissions.length > 1 ? 's' : ''}</span>
            </div>
            <p className="text-xs text-slate-400">
              {submissions.filter(s => s.status === 'pending').length} pending review
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-slate-800">
          <div className="text-xs text-slate-500">
            Posted {format(new Date(task.created_date), 'MMM d, yyyy')}
          </div>
          <Button 
            size="sm" 
            variant="outline"
            onClick={() => setShowDetails(true)}
            className="border-slate-700 text-slate-300 hover:text-slate-100"
          >
            <Eye className="w-4 h-4 mr-2" />
            View Details
          </Button>
        </div>
      </div>

      {/* Details Dialog */}
      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent className="bg-slate-900 border-slate-700 max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-slate-100 text-xl">{task.title}</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-6">
            {/* Status Banner */}
            <div className={`${statusConfig.color} border rounded-lg p-4 flex items-center gap-3`}>
              <StatusIcon className="w-6 h-6" />
              <div>
                <p className="font-semibold">{statusConfig.label}</p>
                <p className="text-xs opacity-80">
                  {task.status === 'open' && 'Waiting for bots to claim this task'}
                  {task.status === 'claimed' && 'A bot is currently working on this'}
                  {task.status === 'completed' && 'Task completed, review submissions below'}
                  {task.status === 'expired' && 'Task deadline has passed'}
                </p>
              </div>
            </div>

            {/* Task Details */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-slate-500 uppercase mb-2">Type</p>
                <p className="text-slate-300">{task.type}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase mb-2">Priority</p>
                <p className="text-slate-300">{task.priority}/10</p>
              </div>
            </div>

            <div>
              <p className="text-xs text-slate-500 uppercase mb-2">Description</p>
              <p className="text-slate-300 whitespace-pre-wrap">{task.description}</p>
            </div>

            {task.requirements && (
              <div>
                <p className="text-xs text-slate-500 uppercase mb-2">Requirements</p>
                <p className="text-slate-300 whitespace-pre-wrap">{task.requirements}</p>
              </div>
            )}

            {/* Payment Info */}
            <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-300">Payment Terms</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-500">Task Price</p>
                  <p className="text-lg font-semibold text-red-400">
                    {task.reward ? `${task.reward} ${task.currency || 'ETH'}` : task.task_price_usd ? `$${task.task_price_usd}` : '$0'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Bot Stake Required</p>
                  <p className="text-lg font-semibold text-red-400">${task.required_stake_usd || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Time Limit</p>
                  <p className="text-slate-300">{task.claim_timeout_minutes} minutes</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Slash Percentage</p>
                  <p className="text-slate-300">{task.slash_percentage}%</p>
                </div>
              </div>
            </div>

            {/* Submissions */}
            {submissions.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-300 mb-3">Submissions</h3>
                <div className="space-y-3">
                  {submissions.map(sub => (
                    <div key={sub.id} className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Bot className="w-4 h-4 text-red-400" />
                          <span className="text-sm text-slate-300">{sub.worker_name}</span>
                        </div>
                        <Badge className={
                          sub.status === 'approved' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                          sub.status === 'rejected' ? 'bg-slate-500/10 text-slate-400' :
                          'bg-red-500/10 text-red-400 border-red-500/30'
                        }>
                          {sub.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-500 mb-2">
                        Submitted {format(new Date(sub.created_date), 'MMM d, yyyy HH:mm')}
                      </p>
                      <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-xs text-slate-400 overflow-x-auto max-h-40">
                        {formatOutput(sub.output_data)}
                      </pre>
                      {sub.review_notes && (
                        <p className="text-xs text-slate-400 mt-2 italic">Note: {sub.review_notes}</p>
                      )}
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