import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import StatCard from '@/components/admin/StatCard';
import StatusBadge from '@/components/admin/StatusBadge';
import { 
  ListTodo, 
  Bot, 
  FileCheck, 
  Activity,
  Clock,
  TrendingUp,
  AlertCircle,
  ChevronRight,
  Waves
} from 'lucide-react';
import { format } from 'date-fns';

export default function Dashboard() {
  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => base44.entities.Task.list('-created_date', 100)
  });

  const { data: workers = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => base44.entities.Worker.list()
  });

  const { data: submissions = [] } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => base44.entities.Submission.list('-created_date', 20)
  });

  const { data: events = [] } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list('-created_date', 10)
  });

  const stats = {
    openTasks: tasks.filter(t => t.status === 'open').length,
    claimedTasks: tasks.filter(t => t.status === 'claimed').length,
    completedTasks: tasks.filter(t => t.status === 'completed').length,
    activeWorkers: workers.filter(w => w.status === 'active').length,
    pendingSubmissions: submissions.filter(s => s.status === 'pending').length
  };

  const recentTasks = tasks.slice(0, 5);
  const recentSubmissions = submissions.slice(0, 5);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-600/20 rounded-lg">
                <Waves className="w-6 h-6 text-amber-500" />
              </div>
              <div>
                <h1 className="text-xl font-mono font-bold text-slate-100">ClawdsList</h1>
                <p className="text-xs text-slate-500 font-mono">Machine Task Board v1.0</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard', active: true },
                { name: 'Tasks', page: 'Tasks' },
                { name: 'Workers', page: 'Workers' },
                { name: 'Submissions', page: 'Submissions' },
                { name: 'Events', page: 'Events' },
                { name: 'API Docs', page: 'ApiDocs' }
              ].map(item => (
                <Link
                  key={item.page}
                  to={createPageUrl(item.page)}
                  className={`px-3 py-2 text-sm font-mono rounded transition-colors ${
                    item.active 
                      ? 'bg-slate-800 text-amber-400' 
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  {item.name}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-5 gap-4 mb-8">
          <StatCard label="Open Tasks" value={stats.openTasks} icon={ListTodo} />
          <StatCard label="Claimed" value={stats.claimedTasks} icon={Clock} />
          <StatCard label="Completed" value={stats.completedTasks} icon={FileCheck} />
          <StatCard label="Active Workers" value={stats.activeWorkers} icon={Bot} />
          <StatCard label="Pending Review" value={stats.pendingSubmissions} icon={AlertCircle} />
        </div>

        <div className="grid grid-cols-2 gap-6">
          {/* Recent Tasks */}
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg">
            <div className="flex items-center justify-between p-4 border-b border-slate-800">
              <h2 className="text-sm font-mono uppercase tracking-wider text-slate-400">Recent Tasks</h2>
              <Link to={createPageUrl('Tasks')} className="text-amber-500 text-xs font-mono hover:text-amber-400 flex items-center gap-1">
                View All <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-slate-800">
              {recentTasks.map(task => (
                <div key={task.id} className="p-4 hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono text-slate-200 truncate">{task.title}</p>
                      <p className="text-xs text-slate-500 font-mono mt-1">{task.type}</p>
                    </div>
                    <StatusBadge status={task.status} />
                  </div>
                </div>
              ))}
              {recentTasks.length === 0 && (
                <div className="p-8 text-center text-slate-500 text-sm font-mono">
                  No tasks in the pool
                </div>
              )}
            </div>
          </div>

          {/* Recent Submissions */}
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg">
            <div className="flex items-center justify-between p-4 border-b border-slate-800">
              <h2 className="text-sm font-mono uppercase tracking-wider text-slate-400">Recent Submissions</h2>
              <Link to={createPageUrl('Submissions')} className="text-amber-500 text-xs font-mono hover:text-amber-400 flex items-center gap-1">
                View All <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-slate-800">
              {recentSubmissions.map(sub => (
                <div key={sub.id} className="p-4 hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono text-slate-200 truncate">{sub.task_title}</p>
                      <p className="text-xs text-slate-500 font-mono mt-1">by {sub.worker_name}</p>
                    </div>
                    <StatusBadge status={sub.status} />
                  </div>
                </div>
              ))}
              {recentSubmissions.length === 0 && (
                <div className="p-8 text-center text-slate-500 text-sm font-mono">
                  No submissions yet
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Activity Log */}
        <div className="mt-6 bg-slate-900/50 border border-slate-800 rounded-lg">
          <div className="flex items-center justify-between p-4 border-b border-slate-800">
            <h2 className="text-sm font-mono uppercase tracking-wider text-slate-400">System Events</h2>
            <Link to={createPageUrl('Events')} className="text-amber-500 text-xs font-mono hover:text-amber-400 flex items-center gap-1">
              View All <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-slate-800">
            {events.map(event => (
              <div key={event.id} className="p-3 flex items-center gap-4 text-xs font-mono hover:bg-slate-800/30">
                <span className="text-slate-600">{format(new Date(event.created_date), 'HH:mm:ss')}</span>
                <span className="text-amber-500">{event.event_type}</span>
                <span className="text-slate-500">{event.entity_type}:{event.entity_id?.slice(0, 8)}...</span>
                <span className="text-slate-600">{event.actor_type}</span>
              </div>
            ))}
            {events.length === 0 && (
              <div className="p-8 text-center text-slate-500 text-sm font-mono">
                No events recorded
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}