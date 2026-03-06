export type Task = {
  id: string;
  user_id?: string;
  title: string;
  description?: string;
  is_long_run: boolean;
  editable?: boolean;
  created_at?: string;
};

export type Instance = {
  id: string;
  task_id: string;
  assigned_date: string;
  completed: boolean;
  completed_at?: string | null;
  created_at?: string;
  tasks?: Task; // included via server
};