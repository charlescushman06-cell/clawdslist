import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { DollarSign, Clock, Shield, Tag } from 'lucide-react';

const TASK_TYPES = [
  { value: 'data_extraction', label: 'Data Extraction' },
  { value: 'content_generation', label: 'Content Generation' },
  { value: 'classification', label: 'Classification' },
  { value: 'transformation', label: 'Data Transformation' },
  { value: 'verification', label: 'Verification' },
  { value: 'code_review', label: 'Code Review' },
  { value: 'other', label: 'Other' }
];

export default function HumanTaskForm({ task, onSubmit, onCancel, isLoading }) {
  const [formData, setFormData] = useState({
    title: task?.title || '',
    type: task?.type || 'data_extraction',
    description: task?.description || '',
    requirements: task?.requirements || '',
    input_data: task?.input_data || '',
    output_schema: task?.output_schema || '',
    task_price_usd: task?.task_price_usd || 0,
    required_stake_usd: task?.required_stake_usd || 0,
    reward_credits: task?.reward_credits || 0,
    claim_timeout_minutes: task?.claim_timeout_minutes || 30,
    slash_percentage: task?.slash_percentage || 100,
    protocol_fee_percentage: task?.protocol_fee_percentage || 5,
    priority: task?.priority || 5
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic Info */}
      <div className="space-y-4">
        <div>
          <Label className="text-slate-300 mb-2">Task Title</Label>
          <Input
            value={formData.title}
            onChange={(e) => setFormData({...formData, title: e.target.value})}
            placeholder="e.g., Extract company data from 50 websites"
            className="bg-slate-800 border-slate-700 text-slate-100"
            required
          />
        </div>

        <div>
          <Label className="text-slate-300 mb-2">Task Type</Label>
          <Select value={formData.type} onValueChange={(value) => setFormData({...formData, type: value})}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-100">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {TASK_TYPES.map(type => (
                <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-slate-300 mb-2">Description</Label>
          <Textarea
            value={formData.description}
            onChange={(e) => setFormData({...formData, description: e.target.value})}
            placeholder="Describe what you need done in detail..."
            className="bg-slate-800 border-slate-700 text-slate-100 h-32"
            required
          />
        </div>

        <div>
          <Label className="text-slate-300 mb-2">Requirements</Label>
          <Textarea
            value={formData.requirements}
            onChange={(e) => setFormData({...formData, requirements: e.target.value})}
            placeholder="Specific requirements for completion..."
            className="bg-slate-800 border-slate-700 text-slate-100 h-24"
          />
        </div>
      </div>

      {/* Data Specs */}
      <div className="bg-slate-800/50 rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <Tag className="w-4 h-4" />
          Data Specifications
        </h3>
        
        <div>
          <Label className="text-slate-300 mb-2 text-xs">Input Data (JSON or URL)</Label>
          <Textarea
            value={formData.input_data}
            onChange={(e) => setFormData({...formData, input_data: e.target.value})}
            placeholder='{"urls": ["https://example.com"]}'
            className="bg-slate-900 border-slate-700 text-slate-100 h-20 font-mono text-xs"
          />
        </div>

        <div>
          <Label className="text-slate-300 mb-2 text-xs">Expected Output Format (JSON Schema)</Label>
          <Textarea
            value={formData.output_schema}
            onChange={(e) => setFormData({...formData, output_schema: e.target.value})}
            placeholder='{"type": "array", "items": {"type": "object"}}'
            className="bg-slate-900 border-slate-700 text-slate-100 h-20 font-mono text-xs"
          />
        </div>
      </div>

      {/* Payment & Timing */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-red-300 flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Payment Terms
          </h3>
          <div>
            <Label className="text-slate-300 mb-2 text-xs">Task Price (USD)</Label>
            <Input
              type="number"
              step="0.01"
              value={formData.task_price_usd}
              onChange={(e) => setFormData({...formData, task_price_usd: parseFloat(e.target.value) || 0})}
              className="bg-slate-900 border-slate-700 text-slate-100"
            />
            <p className="text-xs text-slate-500 mt-1">Amount you'll pay on completion</p>
          </div>
          <div>
            <Label className="text-slate-300 mb-2 text-xs">Protocol Fee (%)</Label>
            <Input
              type="number"
              step="1"
              value={formData.protocol_fee_percentage}
              onChange={(e) => setFormData({...formData, protocol_fee_percentage: parseFloat(e.target.value) || 5})}
              className="bg-slate-900 border-slate-700 text-slate-100"
            />
          </div>
        </div>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-blue-300 flex items-center gap-2">
            <Shield className="w-4 h-4" />
            Security & Timing
          </h3>
          <div>
            <Label className="text-slate-300 mb-2 text-xs">Required Bot Stake (USD)</Label>
            <Input
              type="number"
              step="0.01"
              value={formData.required_stake_usd}
              onChange={(e) => setFormData({...formData, required_stake_usd: parseFloat(e.target.value) || 0})}
              className="bg-slate-900 border-slate-700 text-slate-100"
            />
            <p className="text-xs text-slate-500 mt-1">Security deposit bots must lock</p>
          </div>
          <div>
            <Label className="text-slate-300 mb-2 text-xs">Slash on Failure (%)</Label>
            <Input
              type="number"
              step="1"
              value={formData.slash_percentage}
              onChange={(e) => setFormData({...formData, slash_percentage: parseFloat(e.target.value) || 100})}
              className="bg-slate-900 border-slate-700 text-slate-100"
            />
          </div>
        </div>
      </div>

      <div className="bg-slate-800/50 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-slate-400" />
          <Label className="text-slate-300 text-sm">Time Limit (minutes)</Label>
        </div>
        <Input
          type="number"
          value={formData.claim_timeout_minutes}
          onChange={(e) => setFormData({...formData, claim_timeout_minutes: parseInt(e.target.value) || 30})}
          className="bg-slate-900 border-slate-700 text-slate-100"
        />
        <p className="text-xs text-slate-500 mt-2">Bots must complete within this time or lose their stake</p>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading} className="bg-red-600 hover:bg-red-500">
          {task ? 'Update Task' : 'Post Task'}
        </Button>
      </div>
    </form>
  );
}