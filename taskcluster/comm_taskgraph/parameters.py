#  This Source Code Form is subject to the terms of the Mozilla Public
#  License, v. 2.0. If a copy of the MPL was not distributed with this
#  file, You can obtain one at http://mozilla.org/MPL/2.0/.

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from __future__ import absolute_import, print_function, unicode_literals

import logging

from six import text_type
from voluptuous import (
    Required,
)

from taskgraph.parameters import extend_parameters_schema
from taskgraph.util.partials import populate_release_history

logger = logging.getLogger(__name__)

BALROG_PRODUCT = "Thunderbird"

PER_PROJECT_PARAMETERS = {
    "jamun": {
        "target_tasks_method": "nightly_desktop",
        "release_type": "nightly",
    },
}

# Called at import time when comm_taskgraph:register is called
extend_parameters_schema(
    {
        Required("comm_base_repository"): text_type,
        Required("comm_head_ref"): text_type,
        Required("comm_head_repository"): text_type,
        Required("comm_head_rev"): text_type,
    }
)


def get_decision_parameters(graph_config, parameters):
    logger.info("{}.get_decision_parameters called".format(__name__))
    # If the target method is nightly, we should build partials. This means
    # knowing what has been released previously.
    # An empty release_history is fine, it just means no partials will be built
    project = parameters["project"]

    if project in PER_PROJECT_PARAMETERS:
        parameters.update(PER_PROJECT_PARAMETERS[project])

    parameters.setdefault("release_history", dict())
    if "nightly" in parameters.get("target_tasks_method", ""):
        parameters["release_history"] = populate_release_history(
            BALROG_PRODUCT, project
        )
