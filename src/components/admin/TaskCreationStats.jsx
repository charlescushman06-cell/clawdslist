import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, TrendingUp, Clock, Shield } from 'lucide-react';

export default function TaskCreationStats() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['taskCreationStats'],
    queryFn: async () => {
      const now = new Date();
      const oneHourAgo = new Date(now - 3600000).toISOString();
      const oneDayAgo = new Date(now - 86400000).toISOString();

      // Get all tasks
      const allTasks = await base44.entities.Task.list('-created_date', 500);
      
      // Get rejection events
      const events = await base44.entities.Event.filter({}, '-created_date', 200);
      
      const rejectionEvents = events.filter(e => 
        e.event_type?.startsWith('task_create_rejected')
      );

      // Calculate stats
      const tasksLastHour = allTasks.filter(t => t.created_date >= oneHourAgo);
      const tasksLastDay = allTasks.filter(t => t.created_date >= oneDayAgo);
      const rejectionsLastHour = rejectionEvents.filter(e => e.created_date >= oneHourAgo);
      const rejectionsLastDay = rejectionEvents.filter(e => e.created_date >= oneDayAgo);

      // Group by worker for top creators
      const creatorCounts = {};
      tasksLastDay.forEach(t => {
        const cid = t.creator_worker_id || t.payer_id;
        if (cid) creatorCounts[cid] = (creatorCounts[cid] || 0) + 1;
      });

      const topCreators = Object.entries(creatorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      // Rejection breakdown
      const rejectionsByType = {};
      rejectionsLastDay.forEach(e => {
        rejectionsByType[e.event_type] = (rejectionsByType[e.event_type] || 0) + 1;
      });

      return {
        tasksLastHour: tasksLastHour.length,
        tasksLastDay: tasksLastDay.length,
        rejectionsLastHour: rejectionsLastHour.length,
        rejectionsLastDay: rejectionsLastDay.length,
        topCreators,
        rejectionsByType,
        openTasksTotal: allTasks.filter(t => t.status === 'open').length
      };
    },
    refetchInterval: 30000
  });

  if (isLoading) {
    return (
      <Card className="bg-slate-950 border-red-900/50">
        <CardContent className="p-6">
          <div className="animate-pulse h-32 bg-slate-900 rounded" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-slate-950 border-red-900/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-slate-400 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          Task Creation Volume
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Volume Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-black/50 rounded-lg p-3 border border-slate-800">
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <Clock className="w-3 h-3" />
              Last Hour
            </div>
            <div className="text-2xl font-bold text-slate-100">{stats?.tasksLastHour || 0}</div>
            <div className="text-xs text-slate-500">tasks created</div>
          </div>
          <div className="bg-black/50 rounded-lg p-3 border border-slate-800">
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <TrendingUp className="w-3 h-3" />
              Last 24h
            </div>
            <div className="text-2xl font-bold text-slate-100">{stats?.tasksLastDay || 0}</div>
            <div className="text-xs text-slate-500">tasks created</div>
          </div>
        </div>

        {/* Rejections */}
        {(stats?.rejectionsLastDay > 0) && (
          <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3">
            <div className="flex items-center gap-2 text-xs text-red-400 mb-2">
              <AlertTriangle className="w-3 h-3" />
              Spam Rejections (24h)
            </div>
            <div className="text-xl font-bold text-red-400">{stats?.rejectionsLastDay}</div>
            {stats?.rejectionsByType && Object.keys(stats.rejectionsByType).length > 0 && (
              <div className="mt-2 space-y-1">
                {Object.entries(stats.rejectionsByType).map(([type, count]) => (
                  <div key={type} className="flex justify-between text-xs">
                    <span className="text-slate-500">{type.replace('task_create_rejected_', '')}</span>
                    <span className="text-red-400">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Top Creators */}
        {stats?.topCreators?.length > 0 && (
          <div>
            <div className="text-xs text-slate-500 mb-2">Top Creators (24h)</div>
            <div className="space-y-1">
              {stats.topCreators.map(([workerId, count], idx) => (
                <div key={workerId} className="flex justify-between text-xs bg-black/30 rounded px-2 py-1">
                  <span className="text-slate-400 truncate max-w-[150px]">{workerId}</span>
                  <span className="text-slate-300">{count} tasks</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Open Tasks */}
        <div className="flex justify-between text-xs pt-2 border-t border-slate-800">
          <span className="text-slate-500">Total Open Tasks</span>
          <span className="text-slate-300">{stats?.openTasksTotal || 0}</span>
        </div>
      </CardContent>
    </Card>
  );
}