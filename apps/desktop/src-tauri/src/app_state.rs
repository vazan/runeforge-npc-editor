use std::ops::Deref;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use runeforge_filesystem::{ApprovedRoot, ConfigStore, DiagnosticLog, HistoryStore, RecoveryStore, RootRegistry};

use crate::update::PendingUpdate;

/// Nombre de versions conservees par fichier dans l'historique local.
const HISTORY_VERSIONS: usize = 20;

pub struct Inner {
    pub roots: RootRegistry,
    pub config: ConfigStore,
    pub recovery: RecoveryStore,
    pub history: HistoryStore,
    /// Journal de diagnostic local : n'ecrit que si l'utilisateur l'a active (reglage `logging.enabled`).
    pub log: DiagnosticLog,
    /// Un seul `git` a la fois (voir `commands::git_blocking`).
    pub git: Mutex<()>,
    /// Vrai si l'interface signale des modifications non enregistrees (la fermeture est alors differee).
    pub dirty: AtomicBool,
    /// Projet pre-approuve par une construction de test E2E (toujours `None` hors feature `e2e`).
    pub e2e_project: Mutex<Option<ApprovedRoot>>,
    /// Un seul controle ou une seule installation de mise a jour a la fois (voir `update`).
    pub update_lock: Mutex<()>,
    /// La mise a jour dont le dernier controle a verifie le manifeste signe : l'installation ne telecharge que celle-la.
    pub pending_update: Mutex<Option<PendingUpdate>>,
}

/// Etat partage de l'application (clonable a bas cout pour les taches de fond).
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    /// `config_dir` : preferences et projets recents ; `data_dir` : recuperation et historique (donnees locales).
    pub fn new(config_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self(Arc::new(Inner {
            roots: RootRegistry::new(),
            config: ConfigStore::new(config_dir),
            recovery: RecoveryStore::new(data_dir.clone()),
            log: DiagnosticLog::new(data_dir.join("logs")),
            history: HistoryStore::new(data_dir, HISTORY_VERSIONS),
            git: Mutex::new(()),
            dirty: AtomicBool::new(false),
            e2e_project: Mutex::new(None),
            update_lock: Mutex::new(()),
            pending_update: Mutex::new(None),
        }))
    }
}
