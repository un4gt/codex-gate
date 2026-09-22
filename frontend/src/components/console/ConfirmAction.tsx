import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import { useId } from 'react';
import { useI18n } from '@/lib/i18n';

export function ConfirmAction(props: {
  open: boolean;
  title: string;
  description?: string;
  error?: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return <Dialog open={props.open} onClose={props.busy ? undefined : props.onClose} aria-labelledby={id}>
    <DialogTitle id={id}>{props.title}</DialogTitle>
    {props.description || props.error ? <DialogContent>
      {props.error ? <Alert severity="error">{props.error}</Alert> : null}
      {props.description ? <DialogContentText>{props.description}</DialogContentText> : null}
    </DialogContent> : null}
    <DialogActions>
      <Button autoFocus variant="outline" disabled={props.busy} onClick={props.onClose}>{t('取消')}</Button>
      <Button color="error" disabled={props.busy} onClick={props.onConfirm}>{t(props.busy ? '删除中…' : '确认删除')}</Button>
    </DialogActions>
  </Dialog>;
}
