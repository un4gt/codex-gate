import { render } from 'solid-js/web';
import App from './App';
import { initializeI18n } from '@/lib/i18n';
import './styles.css';

initializeI18n();

render(() => <App />, document.getElementById('root')!);
