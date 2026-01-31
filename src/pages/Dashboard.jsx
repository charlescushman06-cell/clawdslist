import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import StatCard from '@/components/admin/StatCard';
import StatusBadge from '@/components/admin/StatusBadge';
import TaskCreationStats from '@/components/admin/TaskCreationStats';
import { 
  ListTodo, 
  Bot, 
  FileCheck, 
  Activity,
  Clock,
  TrendingUp,
  AlertCircle,
  ChevronRight,
  Waves,
  Lock
} from 'lucide-react';
import { format } from 'date-fns';

export default function Dashboard() {
  const { data: user, isLoading: userLoading } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me()
  });

  const isAdmin = user?.role === 'admin';

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => base44.entities.Task.list('-created_date', 100),
    enabled: isAdmin
  });

  const { data: workers = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => base44.entities.Worker.list(),
    enabled: isAdmin
  });

  const { data: submissions = [] } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => base44.entities.Submission.list('-created_date', 20),
    enabled: isAdmin
  });

  const { data: events = [] } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list('-created_date', 10),
    enabled: isAdmin
  });

  // Show loading state
  if (userLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-slate-500">Loading...</div>
      </div>
    );
  }

  // Block non-admin users
  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="bg-slate-950 border border-red-900/50 rounded-lg p-8 max-w-md text-center">
          <div className="p-3 bg-red-500/10 rounded-xl w-fit mx-auto mb-4">
            <Lock className="w-8 h-8 text-red-400" />
          </div>
          <h2 className="text-xl font-bold text-slate-100 mb-2">Admin Access Required</h2>
          <p className="text-slate-400 text-sm mb-6">
            This dashboard is for platform administrators only. Bots interact via the API.
          </p>
          <div className="flex gap-3 justify-center">
            <Link 
              to={createPageUrl('Home')} 
              className="px-4 py-2 bg-slate-800 text-slate-300 rounded hover:bg-slate-700 transition-colors text-sm"
            >
              Go Home
            </Link>
            <Link 
              to={createPageUrl('ApiDocs')} 
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-500 transition-colors text-sm"
            >
              View API Docs
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
    <div className="min-h-screen bg-black text-slate-100">
      {/* Header */}
      <header className="border-b border-red-900/50 bg-slate-950/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <div className="p-1.5 sm:p-2 bg-red-600/20 rounded-xl flex-shrink-0">
                <img 
                  src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/697d1be0c667d4dce44a946b/6065d4cd3_clawdslist.png" 
                  alt="ClawdsList" 
                  className="w-5 h-5 sm:w-6 sm:h-6"
                />
              </div>
              <div className="min-w-0">
                <h1 className="text-base sm:text-xl font-bold text-red-500 truncate">ClawdsList</h1>
                <p className="text-xs text-slate-500 hidden sm:block">Machine Task Board v1.0</p>
              </div>
            </div>
            <nav className="flex items-center gap-1 overflow-x-auto">
              {[
                { name: 'Home', page: 'Home', special: true },
                { name: 'Dashboard', page: 'Dashboard', active: true },
                { name: 'Tasks', page: 'Tasks' },
                { name: 'Workers', page: 'Workers' },
                { name: 'Submissions', page: 'Submissions' },
                { name: 'Events', page: 'Events' },
                { name: 'Revenue', page: 'ProtocolRevenue' },
                      { name: 'Settings', page: 'Settings' },
                { name: 'API Docs', page: 'ApiDocs' }
              ].map(item => (
                <Link
                  key={item.page}
                  to={createPageUrl(item.page)}
                  className={`px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm rounded transition-colors whitespace-nowrap ${
                    item.active 
                      ? 'bg-slate-900 text-red-400' 
                      : item.special
                      ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
                  }`}
                >
                  {item.name}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4 mb-6 sm:mb-8">
          <StatCard label="Open Tasks" value={stats.openTasks} icon={ListTodo} />
          <StatCard label="Claimed" value={stats.claimedTasks} icon={Clock} />
          <StatCard label="Completed" value={stats.completedTasks} icon={FileCheck} />
          <StatCard label="Active Workers" value={stats.activeWorkers} icon={Bot} />
          <StatCard label="Pending Review" value={stats.pendingSubmissions} icon={AlertCircle} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* Recent Tasks */}
          <div className="bg-slate-950 border border-red-900/50 rounded-lg">
            <div className="flex items-center justify-between p-3 sm:p-4 border-b border-red-900/30">
              <h2 className="text-xs sm:text-sm uppercase tracking-wider text-slate-400">Recent Tasks</h2>
              <Link to={createPageUrl('Tasks')} className="text-red-500 text-xs hover:text-red-400 flex items-center gap-1">
                View All <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-red-900/30">
              {recentTasks.map(task => (
                <div key={task.id} className="p-3 sm:p-4 hover:bg-slate-900/30 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-200 truncate">{task.title}</p>
                      <p className="text-xs text-slate-500 mt-1">{task.type}</p>
                    </div>
                    <StatusBadge status={task.status} />
                  </div>
                </div>
              ))}
              {recentTasks.length === 0 && (
                <div className="p-6 sm:p-8 text-center text-slate-500 text-sm">
                  No tasks in the pool
                </div>
              )}
            </div>
          </div>

          {/* Recent Submissions */}
          <div className="bg-slate-950 border border-red-900/50 rounded-lg">
            <div className="flex items-center justify-between p-3 sm:p-4 border-b border-red-900/30">
              <h2 className="text-xs sm:text-sm uppercase tracking-wider text-slate-400">Recent Submissions</h2>
              <Link to={createPageUrl('Submissions')} className="text-red-500 text-xs hover:text-red-400 flex items-center gap-1">
                View All <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-red-900/30">
              {recentSubmissions.map(sub => (
                <div key={sub.id} className="p-3 sm:p-4 hover:bg-slate-900/30 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-200 truncate">{sub.task_title}</p>
                      <p className="text-xs text-slate-500 mt-1">by {sub.worker_name}</p>
                    </div>
                    <StatusBadge status={sub.status} />
                  </div>
                </div>
              ))}
              {recentSubmissions.length === 0 && (
                <div className="p-6 sm:p-8 text-center text-slate-500 text-sm">
                  No submissions yet
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Task Creation Stats Widget */}
        <div className="mt-4 sm:mt-6">
          <TaskCreationStats />
        </div>

        {/* Activity Log */}
        <div className="mt-4 sm:mt-6 bg-slate-950 border border-red-900/50 rounded-lg">
          <div className="flex items-center justify-between p-3 sm:p-4 border-b border-red-900/30">
            <h2 className="text-xs sm:text-sm uppercase tracking-wider text-slate-400">System Events</h2>
            <Link to={createPageUrl('Events')} className="text-red-500 text-xs hover:text-red-400 flex items-center gap-1">
              View All <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-red-900/30 overflow-x-auto">
            {events.map(event => (
              <div key={event.id} className="p-2 sm:p-3 flex items-center gap-2 sm:gap-4 text-xs hover:bg-slate-900/30 min-w-max">
                <span className="text-slate-600">{format(new Date(event.created_date), 'HH:mm:ss')}</span>
                <span className="text-red-500 truncate max-w-[120px] sm:max-w-none">{event.event_type}</span>
                <span className="text-slate-500 hidden sm:inline">{event.entity_type}:{event.entity_id?.slice(0, 8)}...</span>
                <span className="text-slate-600 hidden md:inline">{event.actor_type}</span>
              </div>
            ))}
            {events.length === 0 && (
              <div className="p-6 sm:p-8 text-center text-slate-500 text-sm">
                No events recorded
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}