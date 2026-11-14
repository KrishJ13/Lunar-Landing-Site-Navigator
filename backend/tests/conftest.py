import pytest
import spiceypy as sp

from lunar_sky import api, kernels


@pytest.fixture
def restore_spice_state():
    """Undo the global effects of a test that starts/stops the app lifespan with broken kernels.

    The lifespan shutdown calls kclear() and flips app.state; both are process-global and would
    otherwise leak into tests that share a live module-scoped client.
    """
    st = api.app.state
    saved = {k: getattr(st, k, None) for k in ("kernels_ready", "kernel_detail", "coverage")}
    with api._spice_lock:
        had_kernels = sp.ktotal("ALL") > 0
    yield
    with api._spice_lock:
        if had_kernels:
            kernels.load_kernels()  # real loader, regardless of monkeypatching on `api`
        else:
            sp.kclear()
    for k, v in saved.items():
        setattr(st, k, v)
